use serde::Deserialize;
use std::collections::BTreeSet;
use syn::{spanned::Spanned, visit::Visit};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exception {
    pub path: String,
    pub category: String,
    pub ceiling: usize,
    pub reason: String,
    pub alternatives: String,
    pub authorization: String,
    pub reassess_by: String,
}

pub fn exceptions(document: &str) -> Result<Vec<Exception>, Box<dyn std::error::Error>> {
    let normalized = document.replace("\r\n", "\n");
    let document = normalized.as_str();
    let start = "<!-- rust-size-exceptions:start -->";
    let end = "<!-- rust-size-exceptions:end -->";
    if document.matches(start).count() != 1 || document.matches(end).count() != 1 {
        return Err("Exactly one Rust exception registry required".into());
    }
    let registry = document
        .split_once(start)
        .ok_or("Missing registry")?
        .1
        .split_once(end)
        .ok_or("Unclosed registry")?
        .0
        .trim();
    let json = registry
        .strip_prefix("```json\n")
        .and_then(|text| text.strip_suffix("\n```"))
        .ok_or("Registry must be a JSON fence")?;
    let entries: Vec<Exception> = serde_json::from_str(json)?;
    let mut seen = BTreeSet::new();
    for entry in &entries {
        let authorized = [
            "https://github.com/DanielssonThomas/Stellar/issues/",
            "https://github.com/DanielssonThomas/Stellar/pull/",
        ]
        .iter()
        .any(|prefix| {
            entry
                .authorization
                .strip_prefix(prefix)
                .is_some_and(|id| id.parse::<u64>().is_ok_and(|id| id > 0))
        });
        if entry.path.contains(['*', '?', '\\'])
            || !entry.path.ends_with(".rs")
            || entry.path.starts_with('/')
            || entry
                .path
                .split('/')
                .any(|part| part == ".." || part.is_empty())
            || !matches!(entry.category.as_str(), "production" | "test")
            || entry.ceiling <= 500
            || entry.reason.trim().is_empty()
            || entry.alternatives.trim().is_empty()
            || !authorized
            || entry.reassess_by.len() != 10
            || !seen.insert((&entry.path, &entry.category))
        {
            return Err("Invalid or duplicate file-specific Rust exception".into());
        }
        let parts: Vec<_> = entry.reassess_by.split('-').collect();
        if parts.len() != 3 {
            return Err("Invalid reassessment date".into());
        }
        let date = time::Date::from_calendar_date(
            parts[0].parse()?,
            time::Month::try_from(parts[1].parse::<u8>()?)?,
            parts[2].parse()?,
        )?;
        if date < time::OffsetDateTime::now_utc().date() {
            return Err("Rust exception reassessment expired".into());
        }
    }
    Ok(entries)
}

struct TestLines<'a> {
    source: Vec<&'a str>,
    selected: BTreeSet<usize>,
}

impl TestLines<'_> {
    fn select(&mut self, attributes: &[syn::Attribute], span: proc_macro2::Span) -> bool {
        let test_only = attributes.iter().any(|attr| {
            attr.path().is_ident("cfg")
                && attr
                    .parse_args::<syn::Path>()
                    .is_ok_and(|path| path.is_ident("test"))
        });
        if !test_only {
            return false;
        }
        let start = span.start();
        let end = span.end();
        for line in start.line..=end.line {
            let text = self.source[line - 1];
            let prefix = if line == start.line {
                text.get(..start.column).unwrap_or(text)
            } else {
                ""
            };
            let suffix = if line == end.line {
                text.get(end.column..).unwrap_or(text).trim()
            } else {
                ""
            };
            if prefix.trim().is_empty() && (suffix.is_empty() || suffix.starts_with("//")) {
                self.selected.insert(line);
            }
        }
        true
    }
}

impl<'ast> Visit<'ast> for TestLines<'_> {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        let attributes = match item {
            syn::Item::Const(v) => &v.attrs,
            syn::Item::Enum(v) => &v.attrs,
            syn::Item::ExternCrate(v) => &v.attrs,
            syn::Item::Fn(v) => &v.attrs,
            syn::Item::ForeignMod(v) => &v.attrs,
            syn::Item::Impl(v) => &v.attrs,
            syn::Item::Macro(v) => &v.attrs,
            syn::Item::Mod(v) => &v.attrs,
            syn::Item::Static(v) => &v.attrs,
            syn::Item::Struct(v) => &v.attrs,
            syn::Item::Trait(v) => &v.attrs,
            syn::Item::TraitAlias(v) => &v.attrs,
            syn::Item::Type(v) => &v.attrs,
            syn::Item::Union(v) => &v.attrs,
            syn::Item::Use(v) => &v.attrs,
            _ => {
                syn::visit::visit_item(self, item);
                return;
            }
        };
        if !self.select(attributes, item.span()) {
            syn::visit::visit_item(self, item);
        }
    }

    fn visit_impl_item(&mut self, item: &'ast syn::ImplItem) {
        let attributes = match item {
            syn::ImplItem::Const(v) => &v.attrs,
            syn::ImplItem::Fn(v) => &v.attrs,
            syn::ImplItem::Type(v) => &v.attrs,
            syn::ImplItem::Macro(v) => &v.attrs,
            _ => {
                syn::visit::visit_impl_item(self, item);
                return;
            }
        };
        if !self.select(attributes, item.span()) {
            syn::visit::visit_impl_item(self, item);
        }
    }

    fn visit_trait_item(&mut self, item: &'ast syn::TraitItem) {
        let attributes = match item {
            syn::TraitItem::Const(v) => &v.attrs,
            syn::TraitItem::Fn(v) => &v.attrs,
            syn::TraitItem::Type(v) => &v.attrs,
            syn::TraitItem::Macro(v) => &v.attrs,
            _ => {
                syn::visit::visit_trait_item(self, item);
                return;
            }
        };
        if !self.select(attributes, item.span()) {
            syn::visit::visit_trait_item(self, item);
        }
    }

    fn visit_foreign_item(&mut self, item: &'ast syn::ForeignItem) {
        let attributes = match item {
            syn::ForeignItem::Fn(v) => &v.attrs,
            syn::ForeignItem::Static(v) => &v.attrs,
            syn::ForeignItem::Type(v) => &v.attrs,
            syn::ForeignItem::Macro(v) => &v.attrs,
            _ => {
                syn::visit::visit_foreign_item(self, item);
                return;
            }
        };
        if !self.select(attributes, item.span()) {
            syn::visit::visit_foreign_item(self, item);
        }
    }
}

pub fn count(path: &str, source: &str) -> Result<(usize, usize), syn::Error> {
    let syntax = syn::parse_file(source)?;
    let total = source.lines().count();
    if path.split('/').any(|segment| segment == "tests") || path.ends_with("_tests.rs") {
        return Ok((0, total));
    }
    let mut tests = TestLines {
        source: source.lines().collect(),
        selected: BTreeSet::new(),
    };
    tests.visit_file(&syntax);
    Ok((total - tests.selected.len(), tests.selected.len()))
}

pub fn validate(
    path: &str,
    category: &str,
    count: usize,
    exceptions: &[Exception],
) -> Result<(), String> {
    if count <= 500 {
        return Ok(());
    }
    if exceptions
        .iter()
        .any(|entry| entry.path == path && entry.category == category && count <= entry.ceiling)
    {
        return Ok(());
    }
    Err(format!(
        "{path}: {category} has {count} physical lines; maximum 500 without a reviewed file-specific exception"
    ))
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
