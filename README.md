# TraMslate

A web studio for translating film and TV subtitles, with a built-in review
round between a translator and a revisor.

The translator imports a script (SRT, VTT or a Word document), translates line
by line against the video and a timeline, and exports SRT or VTT. When the
translation is ready they invite a revisor. The revisor opens the same editor,
proposes replacements, flags problems, adjusts timing and files a report. The
translator then accepts or dismisses each suggestion. Their own wording is
kept, so any accepted suggestion can be reverted.

## Requirements

- .NET 10 SDK
- SQL Server (LocalDB, Express or full)
- The EF Core CLI: `dotnet tool install --global dotnet-ef`
- Node.js 20+ and Chrome or Edge, only to run the tests

## Setup

1. Point `ConnectionStrings:DefaultConnection` in `appsettings.json` (or an
   untracked `appsettings.Development.json`) at your SQL Server, for example:

   ```json
   "DefaultConnection": "Server=(localdb)\\MSSQLLocalDB;Database=TraMslate;Trusted_Connection=True;TrustServerCertificate=True;"
   ```

2. Create the database:

   ```sh
   dotnet ef database update
   ```

3. Run the app, then open the URL it prints and register an account:

   ```sh
   dotnet run
   ```

Uploaded videos are stored in `wwwroot/uploads/`. They are only ever served to
people on the project, through `/studio/{id}/media`.

## Working on a project

| Who | Can |
|---|---|
| **Translator** (the project's owner) | Import and export, write translations, add, split, merge and delete lines, change timing, set line and project status, accept, dismiss or revert suggestions, invite or remove revisors, edit project settings (title, languages, video) |
| **Revisor** (invited by email) | Change timing, propose a replacement for any line, flag lines by error type and severity, leave a note per line, file a report that sends the project back or approves it |

The review flow:

1. The translator opens **People** (the people icon in the editor) and invites
   the revisor by email. The revisor needs an account first.
2. **Send for review** hands the project over. It shows up under the revisor's
   dashboard.
3. The revisor works in the suggestion column, then presses **Finish review**,
   writes a report and chooses *Send back* or *Approve*.
4. The translator sees the report at the top of the editor. The lightbulb button
   shows the suggestions, and the filter can list only suggested or flagged lines.

Both people can have the project open at the same time. Each save merges the
other person's latest changes. The editor asks for a reload only when both
changed the same field of the same line.

Account settings (name, password) are under your name in the top bar. After
five wrong passwords, sign-in is locked for a few minutes.

## Tests

```sh
node --test tests/*.test.cjs            # unit tests: subtitle parsing, editor state, review logic
node tests/browser/check-all.cjs        # layout, workflow, revisor seat and performance in headless Chrome
node tests/browser/check-all.cjs --app  # …plus live tours of the running app at http://127.0.0.1:5199
```

The live tours sign in as `tour@tramslate.local` and `tour-revisor@tramslate.local`,
create projects prefixed `Tour`, and delete them afterwards. If a run fails
partway, `node tests/browser/clean-tour-data.cjs` removes whatever it left behind.
See [tests/browser/README.md](tests/browser/README.md) for details.

## Not included yet

- **Password reset by email.** There is no mail service configured. A user who
  forgets their password needs an administrator to reset it in the database.
- **Translation memory and glossary**, **machine translation**, and **stored
  revision history**. See [PROJECT-REVIEW.md](PROJECT-REVIEW.md) for the fuller list.
