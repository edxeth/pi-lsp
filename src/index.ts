import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lspHookFactory from "./lsp.js";
import lspToolFactory from "./lsp-tool.js";

export default function (pi: ExtensionAPI) {
  lspHookFactory(pi);
  lspToolFactory(pi);
}
