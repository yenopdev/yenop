// Must a person see this first? A permit here means "ask".

@id("destructive-shell")
permit (principal, action == Yenop::Action::"call", resource)
when {
  resource.kind == "shell" && context.args has command &&
  ( context.args.command like "*rm -r*" ||
    context.args.command like "*rm -f*" ||
    context.args.command like "*rm -Rf*" ||
    context.args.command like "*rmdir *" ||
    context.args.command like "*terraform destroy*" ||
    context.args.command like "*terraform apply*" ||
    context.args.command like "*pulumi destroy*" ||
    context.args.command like "*git push*--force*" ||
    context.args.command like "*git push*-f *" ||
    context.args.command like "*git reset --hard*" ||
    context.args.command like "*git clean*" ||
    context.args.command like "*git branch -D*" ||
    context.args.command like "*DROP TABLE*" ||
    context.args.command like "*DROP DATABASE*" ||
    context.args.command like "*DROP SCHEMA*" ||
    context.args.command like "*DELETE FROM*" ||
    context.args.command like "*TRUNCATE*" ||
    context.args.command like "*kubectl delete*" ||
    context.args.command like "*helm uninstall*" ||
    context.args.command like "*docker rm*" ||
    context.args.command like "*docker system prune*" ||
    context.args.command like "*aws * delete*" ||
    context.args.command like "*aws * terminate*" ||
    context.args.command like "*gcloud * delete*" ||
    context.args.command like "*az * delete*" ||
    context.args.command like "*sudo *" ||
    context.args.command like "*chmod -R*" ||
    context.args.command like "*chown -R*" ||
    context.args.command like "*mkfs*" ||
    context.args.command like "*> /dev/*" )
};

@id("outbound-writes-from-shell")
permit (principal, action == Yenop::Action::"call", resource)
when {
  resource.kind == "shell" && context.args has command &&
  ( context.args.command like "*curl*-X POST*" ||
    context.args.command like "*curl*-X PUT*" ||
    context.args.command like "*curl*-X DELETE*" ||
    context.args.command like "*curl*-X PATCH*" ||
    context.args.command like "*curl*--data*" ||
    context.args.command like "*curl*-d *" ||
    context.args.command like "*wget*--post*" ||
    context.args.command like "*ssh *" ||
    context.args.command like "*scp *" ||
    context.args.command like "*rsync *" ||
    context.args.command like "*npm publish*" ||
    context.args.command like "*git push*" ||
    context.args.command like "*gh pr merge*" ||
    context.args.command like "*gh release*" )
};

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
