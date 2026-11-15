"""Select personal-host tools without letting the renderer choose launch authority."""


def select_toolsets(config, resolve):
    if type(config) is not dict:
        raise ValueError('Invalid profile configuration')
    platforms = config.get('platform_toolsets', {})
    if type(platforms) is not dict:
        raise ValueError('Invalid profile toolsets')
    platform = 'desktop' if 'desktop' in platforms else 'cli'
    if platform in platforms:
        names = platforms[platform]
        if (type(names) is not list or len(names) > 256
                or any(type(name) is not str or not name.strip() or name != name.strip()
                       for name in names) or len(set(names)) != len(names)):
            raise ValueError('Invalid profile tool selection')
    # Hermes resolves composites, MCP/plugin selections and global disabled toolsets.
    names = resolve(config, platform)
    if (type(names) is not set or any(type(name) is not str or not name for name in names)):
        raise ValueError('Invalid resolved profile tools')
    # Hermes' own Electron UI tools only exist on source=gui, never an ACP client.
    return sorted(names - {'desktop_ui'})


def load_toolsets():
    from hermes_cli.config import load_config
    from hermes_cli.tools_config import _get_platform_tools
    return select_toolsets(load_config(), _get_platform_tools)
