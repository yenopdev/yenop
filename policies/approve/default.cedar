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

// Yenop protects itself. An agent may not loosen its own guard: changing Yenop's config, policies,
// mode or daemon, or the hook registration that keeps Yenop in the loop, always goes past a person.
@id("changes-to-yenop-itself")
permit (principal, action == Yenop::Action::"call", resource)
when {
  (context has shell && context.shell.controlPlane) ||
  (resource.kind == "write" && context.derived has controlPlanePath && context.derived.controlPlanePath)
};

// Offensive security tooling: scanners, exploitation frameworks, credential attacks, reverse shells.
// Dual-use, so a person signs off rather than an outright refusal. A pentest team that runs these daily
// disables this with "disabledPolicies": ["offensive-tooling"], or tightens it to a forbid.
@id("offensive-tooling")
permit (principal, action == Yenop::Action::"call", resource)
when { context has shell && context.shell.offensiveTool };

// Sequence rules. A plan split into harmless-looking steps still adds up: these look at what the
// run has already done, not only at this call. Calls to localhost and private ranges do not count.

@id("external-network-after-sensitive-data")
permit (principal, action == Yenop::Action::"call", resource)
when { context.run.sensitive && context.flow.externalNetwork };

// Untrusted input, sensitive data, and a way out, all in one run: the exfiltration shape.
@id("lethal-trifecta")
permit (principal, action == Yenop::Action::"call", resource)
when { context.run.untrusted && context.run.sensitive && context.flow.externalNetwork };

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
