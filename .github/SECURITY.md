# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a
vulnerability**, or go straight to
[the report form](https://github.com/parsingk/Astera/security/advisories/new). Only the maintainers
can see what you send.

It helps to include what an attacker can do, the steps or a proof of concept, the Astera version and
your OS. You will get a reply within a week. Once a fix is released, the advisory is published with
credit to you, unless you would rather not be named.

## What is in scope

Astera runs agent CLIs on your machine and talks to a background process, the Astera Host, over a
local pipe or socket. Of particular interest:

- another local account, or a repository you open, getting Astera to run something or reveal a
  session's input or output
- a file outside the project being written through the explorer or the editor
- the `astera` command or the Host acting for someone other than the account that runs them

What an agent session does with the permissions you give it is up to that agent and those
permissions, and is covered in the Security section of [docs/cli.md](../docs/cli.md).

## Supported versions

Fixes go into the next release. Only the latest release is supported, so please update before
reporting.
