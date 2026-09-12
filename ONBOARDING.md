# Welcome to Haefele Software

## How We Use Claude

Based on Divan's usage over the last 30 days:

Work Type Breakdown:
  Build Feature     ████████████░░░░░░░░  58%
  Debug Fix         ████░░░░░░░░░░░░░░░░  16%
  Improve Quality   ███░░░░░░░░░░░░░░░░░  16%
  Plan Design       ██░░░░░░░░░░░░░░░░░░  10%

Top Skills & Commands:
  /goal                    ████████████████████  27x/month
  /impeccable:impeccable   ███████████████░░░░░  20x/month
  /clear                   ██████░░░░░░░░░░░░░░  8x/month
  /effort                  ████░░░░░░░░░░░░░░░░  6x/month
  /release                 ████░░░░░░░░░░░░░░░░  6x/month
  /ui-ux-pro-max:design    ███░░░░░░░░░░░░░░░░░  4x/month
  /deep-research           ██░░░░░░░░░░░░░░░░░░  3x/month
  /ponytail:ponytail-audit ██░░░░░░░░░░░░░░░░░░  2x/month

Top MCP Servers:
  mssql-einstein  ████████████████████  3 calls
  switchboard     ███████░░░░░░░░░░░░░  1 call

## Your Setup Checklist

### Codebases
- [ ] switchboard — github.com/divanlr/switchboard (Electron and Vue desktop app hosting many Claude Code sessions)
- [ ] ArchitectureGalaxy — github.com/DivanLR/ArchitectureGalaxy (Angular and three.js world that visualises the WarehouseManager architecture)
- [ ] WarehouseManager — the .NET vertical slice API the galaxy snapshots its source from

### MCP Servers to Activate
- [ ] mssql-einstein — SQL Server schema and query access for the Einstein databases. Ask Jonathan or Henry for the connection profile and add it to your Claude Code MCP settings.
- [ ] switchboard — the Switchboard app's own MCP for cross session handovers. Enabled automatically when you run the Switchboard app locally.

### Skills to Know About
- /goal — sets the objective a session works toward; we start most sessions with it.
- /impeccable:impeccable — design and polish frontend UI, including live variant previews in the browser.
- /release — cuts and publishes a GitHub release from every change since the last tag, running the repo's checks first.
- /effort — picks the reasoning effort for the session; drop it for small edits, raise it for architecture work.
- /ui-ux-pro-max:design — quick UI mockups and design system passes.
- /deep-research — background research against primary sources, captured as a Markdown file in the repo.
- /ponytail:ponytail-audit — whole repo audit for over engineering; ponytail mode keeps every change as small as it can be.
- /clear — reset context between unrelated tasks; each spec, test run, cleanup or diagram gets its own session.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
