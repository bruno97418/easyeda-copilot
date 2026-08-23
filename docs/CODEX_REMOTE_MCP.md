# Codex + EasyEDA Copilot over LAN

This fork keeps the original EasyEDA Copilot MCP workflow and adds a configurable WebSocket endpoint so EasyEDA can run on an older Windows PC while Codex and the Node.js MCP server run on a modern computer.

## Architecture

```text
Codex (modern PC / macOS)
        |
        | MCP stdio
        v
 easyeda-copilot-mcp (Node >= 20)
        |
        | WebSocket TCP 8787 over LAN
        v
EasyEDA Pro + EasyEDA Copilot extension (Windows PC)
        |
        v
schematic / PCB / component search / assembly / DRC
```

The built-in Copilot UI remains available. Codex uses the MCP tools directly for the advanced workflow.

## 1. EasyEDA computer

Install the extension built from branch `codex/easyeda-ai`.

This fork accepts EasyEDA Pro 3.2.148 or newer.

Open a schematic or PCB and use:

`Copilot -> MCP connection...`

Set the WebSocket URL to the LAN address of the computer running Codex/MCP, for example:

```text
ws://192.168.1.50:8787
```

Use `Copilot -> Reset MCP connection` to return to:

```text
ws://127.0.0.1:8787
```

The selected URL is stored locally by the EasyEDA renderer.

## 2. Codex / MCP computer

Use a current Node.js release supported by the upstream MCP package (Node 20 or newer).

The MCP server already supports a configurable bind host through `EASYEDA_COPILOT_MCP_WS_HOST`. For LAN operation, bind it to all local interfaces:

### Windows PowerShell

```powershell
$env:EASYEDA_COPILOT_MCP_WS_HOST='0.0.0.0'
$env:EASYEDA_COPILOT_MCP_WS_PORT='8787'
```

### macOS / Linux

```bash
export EASYEDA_COPILOT_MCP_WS_HOST=0.0.0.0
export EASYEDA_COPILOT_MCP_WS_PORT=8787
```

Then start Codex with the EasyEDA Copilot MCP server configured as documented in `mcp/README.md`.

## 3. Firewall

Allow inbound TCP port 8787 on the Codex/MCP computer only for the trusted local network.

Do **not** expose port 8787 directly to the Internet. The upstream bridge protocol is intended for trusted local use and does not provide Internet-grade authentication.

## 4. Validation

When the connection is established:

1. EasyEDA shows `MCP connected`.
2. Codex can list the connected EasyEDA instance.
3. Read the current schematic before making changes.
4. Save a checkpoint before substantial modifications.
5. Run DRC after schematic/PCB changes where applicable.

## Why this mode exists

The upstream MCP package requires Node.js 20+, while older Windows installations may not support a current Node runtime. Moving Codex + MCP to a modern machine avoids rewriting the upstream MCP toolset and keeps the original EasyEDA Copilot functionality intact.
