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

// Tools Yenop has never seen are permitted, but the approval set below makes a person look first.
@id("unknown-tools")
permit (principal, action == Yenop::Action::"call", resource)
when { resource.kind == "unknown" };

// Hard stops. These win over every permit above.

@id("no-secret-files-in-shell")
forbid (principal, action, resource)
when {
  context.args has command &&
  ( context.args.command like "*/.ssh/id_*" ||
    context.args.command like "*/.ssh/config*" ||
    context.args.command like "*/.aws/credentials*" ||
    context.args.command like "*/.env" ||
    context.args.command like "*/.env.*" ||
    context.args.command like "*.pem *" ||
    context.args.command like "*.pem" )
};

@id("no-secret-files-by-path")
forbid (principal, action, resource)
when {
  context.args has file_path &&
  ( context.args.file_path like "*/.ssh/*" ||
    context.args.file_path like "*/.aws/credentials" ||
    context.args.file_path like "*/.env" ||
    context.args.file_path like "*/.env.*" ||
    context.args.file_path like "*.pem" )
};

@id("no-pipe-to-shell")
forbid (principal, action, resource)
when {
  context.args has command &&
  ( context.args.command like "*| sh*" ||
    context.args.command like "*|sh*" ||
    context.args.command like "*| bash*" ||
    context.args.command like "*|bash*" ||
    context.args.command like "*| zsh*" )
};

@id("no-shell-secret-exfil")
forbid (principal, action, resource)
when {
  context.args has command &&
  context.args.command like "*curl*" &&
  ( context.args.command like "*$*KEY*" ||
    context.args.command like "*$*TOKEN*" ||
    context.args.command like "*$*SECRET*" )
};
