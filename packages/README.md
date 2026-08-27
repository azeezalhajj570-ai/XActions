# packages/

Publishable sub-packages that ship separately from the main `xactions` package.

- `xactions-mcp/`: a thin distribution of the MCP server for registries that want a dedicated package (`npx xactions-mcp`).

Each package has its own `package.json`; run its scripts from inside the directory:

    cd packages/xactions-mcp && npm install && npm start
