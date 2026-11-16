# Source and attribution

Media Desk MCP is an independent runtime fork of
[woniuniuniu/dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk),
fixed at commit `3a23cb899691c29238138c76deb200114ce1830c` (2.7.2).
Its MIT license and original author attribution remain in `LICENSE`.

The `client/` frontend and `assets/` source files are reused byte for byte.
Run `npm run verify:frontend` to verify the pinned baseline.

The independent browser shell includes theme CSS from
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
commit `39163dd30f703a79079e2d2446545cff3c453738`.
The corresponding MIT notice is retained at `standalone/theme/LICENSE`.
No DeepSeek Harness runtime is needed to launch this application.

The design of separate incoming MCP access and outgoing CLI runtime adapters was
informed by [OpenDesign's adapter architecture](https://github.com/nexu-io/open-design/blob/84dd08b5709bfa4bf4108ece8424d15e4062c982/docs/agent-adapters.md).
This project does not vendor OpenDesign's runtime implementation.

This fork is independent from the original authors, DeepSeek, OpenDesign,
OpenAI, and Moonshot AI. Their names identify compatible software and sources.
