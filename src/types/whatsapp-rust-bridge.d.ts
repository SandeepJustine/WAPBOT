declare module "whatsapp-rust-bridge" {
  export type EncodingNode = {
    tag: string;
    attrs: Record<string, string>;
    content?: EncodingNode[] | Uint8Array | string | null;
  };
}
