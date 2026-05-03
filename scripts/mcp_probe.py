import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("probe")
LOG_FILE = Path(os.getenv("MCP_PROBE_LOG", "./mcp_probe.log"))


@mcp.tool()
def probe_tool(message: str = "hello") -> dict:
    """A canary tool for verifying real MCP execution."""
    event = {
        "id": str(uuid.uuid4()),
        "message": message,
        "executed_at": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
    }

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

    return event


@mcp.tool()
def fail_tool(reason: str = "intentional failure") -> str:
    """A tool that always fails, useful for testing error handling."""
    raise RuntimeError(reason)


if __name__ == "__main__":
    mcp.run(transport="stdio")
