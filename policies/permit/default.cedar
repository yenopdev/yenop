// yenop baseline pack, vocabulary v1. Do not edit in place: add your own files in
// ~/.yenop/policies or <project>/.yenop/policies, and switch a rule off with
// "disabledPolicies" in config.json.
//
// May this happen at all? Cedar's default is deny.

@id("read-only-tools")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.readOnly };

@id("edit-tools")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "write" };

@id("shell")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "shell" };

@id("mcp-tools")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "mcp" };

@id("web-tools")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "web" };

// Tools Yenop has never seen are permitted; the approval set makes a person look first.
@id("unknown-tools")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "unknown" };

// Hard stops. These win over every permit above. They test parsed facts, not text,
// so a README that mentions a key file, or a public key, does not trip them.

@id("no-secret-files")
forbid (principal, action == Yenop::Action::"call", resource)
when {
  (context has shell && context.shell.secretPath) ||
  (context.derived has secretPath && context.derived.secretPath)
};

@id("no-pipe-to-shell")
forbid (principal, action == Yenop::Action::"call", resource)
when { context has shell && context.shell.pipesToShell };

@id("no-secret-exfil")
forbid (principal, action == Yenop::Action::"call", resource)
when { context has shell && context.shell.network && context.shell.secretEnv };
