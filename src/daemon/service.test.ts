import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import { servicePlan, SERVICE_LABEL } from "./service.js";

const tail = (p: string, n: number) => p.split(sep).slice(-n); // separator-agnostic: this test also runs on Windows

describe("service plan", () => {
  it("builds a launchd plist that invokes node by absolute path and bakes in home and PATH", () => {
    const p = servicePlan("/tmp/yenop-home", "darwin");
    expect(p.platform).toBe("darwin");
    expect(tail(p.unitPath, 3)).toEqual(["Library", "LaunchAgents", "com.yenop.daemon.plist"]);
    expect(p.unit).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(p.unit).toContain("<key>YENOP_HOME</key>");
    expect(p.unit).toContain("/tmp/yenop-home");
    expect(p.unit).toContain("<key>KeepAlive</key>");
    expect(p.unit).toContain("<key>PATH</key>"); // launchd's minimal PATH is widened to include node's dir
    expect(p.unit).toMatch(/<string>[^<]*node[^<]*<\/string>/); // absolute node, not a bare "yenop"
    expect(p.unit).toMatch(/<string>daemon<\/string>\s*<string>run<\/string>/);
  });
  it("builds a systemd user unit with an absolute ExecStart, home, PATH, and restart", () => {
    const p = servicePlan("/var/lib/yenop", "linux");
    expect(p.platform).toBe("linux");
    expect(tail(p.unitPath, 3)).toEqual(["systemd", "user", "yenop.service"]);
    expect(p.unit).toMatch(/^\[Unit\]/m);
    expect(p.unit).toMatch(/ExecStart=\/.*node.* .*daemon run/); // absolute node path, ends in daemon run
    expect(p.unit).toContain("Environment=YENOP_HOME=/var/lib/yenop");
    expect(p.unit).toMatch(/Environment=PATH=\/.*:\/usr\/bin:\/bin/);
    expect(p.unit).toContain("Restart=always");
    expect(p.unit).toContain("WantedBy=default.target");
  });
  it("reports unsupported for Windows with an empty unit", () => {
    const p = servicePlan("/x", "win32");
    expect(p.platform).toBe("unsupported");
    expect(p.unit).toBe("");
    expect(p.unitPath).toBe("");
  });
  it("the argv always ends in daemon run", () => {
    const p = servicePlan("/x");
    expect(p.argv.slice(-2)).toEqual(["daemon", "run"]);
  });
});
