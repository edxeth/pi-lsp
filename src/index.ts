import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import lspHookFactory from "./lsp.js";
import lspToolFactory from "./lsp-tool.js";

export default function (pi: ExtensionAPI) {
  lspHookFactory(pi);
  lspToolFactory(pi);
}
