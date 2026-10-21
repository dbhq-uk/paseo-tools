import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface State {
  port?: number;
  /** token -> agent id, or null while the agent is still being created */
  connections: Record<string, string | null>;
}

const MAX_CONNECTIONS = 5000;

/**
 * Which agent holds which connection token. The token goes into the agent's MCP
 * configuration when it is created, before the agent has an id. The session-open
 * hook then sees the same token in the agent's environment and binds the two.
 *
 * The map is kept in a 0600 file, because the agent's saved MCP configuration
 * outlives the daemon and the plugin: after a restart the old token must still
 * mean the same agent.
 */
export class Connections {
  private state: State = { connections: {} };

  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as State;
        if (parsed && typeof parsed.connections === "object") this.state = { ...parsed, connections: parsed.connections ?? {} };
      }
    } catch {
      this.state = { connections: {} };
    }
  }

  get port(): number | undefined {
    return this.state.port;
  }

  setPort(port: number): void {
    this.state.port = port;
    this.save();
  }

  issue(): string {
    const token = randomBytes(24).toString("base64url");
    this.state.connections[token] = null;
    const tokens = Object.keys(this.state.connections);
    for (const old of tokens.slice(0, Math.max(0, tokens.length - MAX_CONNECTIONS))) delete this.state.connections[old];
    this.save();
    return token;
  }

  bind(token: string, agentId: string): boolean {
    if (!this.has(token)) return false;
    this.state.connections[token] = agentId;
    this.save();
    return true;
  }

  agentFor(token: string): string | null {
    const found = this.find(token);
    return found ? this.state.connections[found] : null;
  }

  private has(token: string): boolean {
    return this.find(token) !== undefined;
  }

  /** Compare against every known token in constant time, so timing leaks nothing. */
  private find(token: string): string | undefined {
    const given = Buffer.from(token);
    let match: string | undefined;
    for (const known of Object.keys(this.state.connections)) {
      const candidate = Buffer.from(known);
      if (candidate.length === given.length && timingSafeEqual(candidate, given)) match = known;
    }
    return match;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }
}
