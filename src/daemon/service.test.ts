import { describe, it, expect } from "vitest";
import { servicePlan, SERVICE_LABEL } from "./service.js";

describe("service plan", () => {
  it("produces a valid-looking unit for this platform with the home baked in", () => {
    const p = servicePlan("/tmp/yenop-home");
    if (p.platform === "darwin") {
      expect(p.unitPath).toMatch(/Library\/LaunchAgents\/com\.yenop\.daemon\.plist$/);
      expect(p.unit).toContain(`<string>${SERVICE_LABEL}</string>`);
      expect(p.unit).toContain("<key>YENOP_HOME</key>");
      expect(p.unit).toContain("/tmp/yenop-home");
      expect(p.unit).toContain("<key>KeepAlive</key>");
      expect(p.unit).toMatch(/<string>[^<]*daemon<\/string>\s*<string>run<\/string>/);
    } else if (p.platform === "linux") {
      expect(p.unitPath).toMatch(/systemd\/user\/yenop\.service$/);
      expect(p.unit).toContain("Restart=always");
      expect(p.unit).toContain("Environment=YENOP_HOME=/tmp/yenop-home");
      expect(p.unit).toMatch(/ExecStart=.*daemon run/);
    }
    expect(p.argv[p.argv.length - 2]).toBe("daemon");
    expect(p.argv[p.argv.length - 1]).toBe("run");
  });
});
