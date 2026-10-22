## ❌ Changes requested

- dashboard/src/mcp/pairing.ts, sendPaired: the owner send response’s isError flag is ignored. HTTP 200 with { text: "...", isError: true } returns kind: "sent", reporting a failed send as successful. Preserve the error flag and return an error result instead.

---
*[View full details](https://jean-ci.telegraphic.app/checks/4934)*
