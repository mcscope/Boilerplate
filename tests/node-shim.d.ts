// Minimal Node typings for the test scripts (the project doesn't depend on @types/node).
declare const process: {
  argv: string[];
  execPath: string;
  exitCode: number | undefined;
  exit(code?: number): never;
  stdout: { write(s: string): boolean };
  env: Record<string, string | undefined>;
  cpuUsage(previous?: { user: number; system: number }): { user: number; system: number };
};
declare module 'os' {
  export function cpus(): unknown[];
}
declare module 'child_process' {
  interface Child {
    stdout: { on(ev: 'data', cb: (d: unknown) => void): void };
    on(ev: 'close', cb: (code: number) => void): void;
  }
  export function spawn(cmd: string, args: string[], opts?: unknown): Child;
}
