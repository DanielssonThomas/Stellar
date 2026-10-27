// One request only. This credential-free container sees no repository mount.
const model = 'http://peon-model:18435';
const meter = 'http://peon-meter:18436';
export async function performDirectPatch(
  prompt,
  { fetchImpl = fetch, signal = AbortSignal.timeout(180_000) } = {},
) {
  if (typeof prompt !== 'string' || prompt.length > 15_000)
    throw new Error('input-shape');
  const post = async (url, body) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error('transport');
    return response.json();
  };
  const messages = [{ role: 'user', content: prompt }];
  const applied = await post(`${model}/apply-template`, { messages });
  if (typeof applied.prompt !== 'string') throw new Error('tokenizer');
  const tokenized = await post(`${model}/tokenize`, {
    content: applied.prompt,
    add_special: true,
  });
  if (!Array.isArray(tokenized.tokens) || tokenized.tokens.length > 1_800)
    throw new Error('prompt-limit');
  const reply = await post(`${meter}/v1/chat/completions`, {
    model: 'Qwen3.5-4B-Q4_K_M',
    messages,
    max_tokens: 1_200,
    n: 1,
    stream: false,
    temperature: 0,
  });
  if (
    !Array.isArray(reply.choices) ||
    reply.choices.length !== 1 ||
    typeof reply.choices[0]?.message?.content !== 'string' ||
    reply.choices[0].message.tool_calls ||
    reply.choices[0].message.function_call
  )
    throw new Error('response-shape');
  return {
    patch: reply.choices[0].message.content,
    usage: reply.usage,
    preflightPromptTokens: tokenized.tokens.length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  try {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 20_000) throw new Error('input-size');
    }
    const input = JSON.parse(text);
    process.stdout.write(
      JSON.stringify(await performDirectPatch(input.prompt)),
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ category: String(error.message).slice(0, 40) }),
    );
    process.exitCode = 1;
  }
}
