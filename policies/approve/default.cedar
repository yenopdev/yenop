// yenop baseline pack, vocabulary v1. Do not edit in place: add your own files in
// ~/.yenop/policies or <project>/.yenop/policies, and switch a rule off with
// "disabledPolicies" in config.json.
//
// Must a person see this first? A permit here means "ask".

@id("destructive-shell")
permit (principal, action == Yenop::Action::"call", resource)
when { context has shell && context.shell.destructive };

@id("outbound-writes-from-shell")
permit (principal, action == Yenop::Action::"call", resource)
when { context has shell && context.shell.outbound };

@id("sudo")
permit (principal, action == Yenop::Action::"call", resource)
when { context has shell && context.shell.sudo };

@id("mcp-writes")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "mcp" && !resource.readOnly };

@id("writes-outside-project")
permit (principal, action == Yenop::Action::"call", resource)
when {
  resource.kind == "write" &&
  context.derived has insideProject &&
  !context.derived.insideProject
};

@id("unknown-tools-need-a-person")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "unknown" };

@id("publishing-outside")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "web" && !resource.readOnly };
