const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function isSafeOpencodeSessionId(value: string | undefined): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export interface BuildOpencodeArgsInput {
  sessionId?: string;
  model?: string;
  attach?: string;
  password?: string;
  username?: string;
  thinking?: boolean;
}

export function buildOpencodeArgs(input: BuildOpencodeArgsInput): string[] {
  const args = ["run", "--format", "json", "--auto"];

  if (input.thinking !== false) {
    args.push("--thinking");
  }

  if (input.sessionId) {
    if (!isSafeOpencodeSessionId(input.sessionId)) {
      throw new Error(`invalid opencode session id: ${input.sessionId}`);
    }
    args.push("-s", input.sessionId);
  }

  if (input.model && input.model !== "default") {
    args.push("-m", input.model);
  }

  if (input.attach) {
    args.push("--attach", input.attach);
    if (input.password) {
      args.push("-p", input.password);
    }
    if (input.username) {
      args.push("-u", input.username);
    }
  }

  return args;
}
