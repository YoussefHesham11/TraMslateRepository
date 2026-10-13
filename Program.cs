using System.Diagnostics;
using System.Net;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using TraMslate.Data;
using TraMslate.Models;
using WinForms = System.Windows.Forms;

namespace TraMslate;

public static class Program
{
    // Fixed port so the editor's saved settings (localStorage) survive restarts.
    private const int Port = 5282;

    [STAThread]
    public static void Main(string[] args)
    {
        // Published .exe: everything lives next to the .exe (works from a flash drive).
        // dotnet run (Development): keep the normal project folder, and keep test data
        // outside it so it never ends up in git or in the published program.
        var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")
                  ?? Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT");
        var isDev = string.Equals(env, "Development", StringComparison.OrdinalIgnoreCase);

        var dataFolder = isDev
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TraMslate-dev")
            : Path.Combine(AppContext.BaseDirectory, "Data");
        Directory.CreateDirectory(dataFolder);

        WebApplication app;
        try
        {
            app = BuildWebApp(args, isDev, dataFolder);
            app.Start(); // local server, only reachable from this PC
        }
        catch (IOException)
        {
            WinForms.MessageBox.Show("TraMslate is already open.", "TraMslate",
                WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
            return;
        }
        catch (Exception ex)
        {
            WinForms.MessageBox.Show("TraMslate could not start:\n\n" + ex.Message, "TraMslate",
                WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
            return;
        }

        WinForms.Application.SetHighDpiMode(WinForms.HighDpiMode.PerMonitorV2);
        WinForms.Application.EnableVisualStyles();
        WinForms.Application.SetCompatibleTextRenderingDefault(false);
        WinForms.Application.Run(new MainWindow($"http://127.0.0.1:{Port}/", dataFolder,
                                                app.Environment.WebRootPath));

        // Window closed -> stop the local server.
        app.StopAsync().GetAwaiter().GetResult();
    }

    private static WebApplication BuildWebApp(string[] args, bool isDev, string dataFolder)
    {
        var options = isDev
            ? new WebApplicationOptions { Args = args }
            : new WebApplicationOptions { Args = args, ContentRootPath = AppContext.BaseDirectory };

        var builder = WebApplication.CreateBuilder(options);

        // ── Database: one SQLite file, no server ──────────────
        var dbPath = Path.Combine(dataFolder, "tramslate.db");
        builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlite($"Data Source={dbPath}"));

        // Keep logins valid on any PC the flash drive is plugged into.
        builder.Services.AddDataProtection()
            .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataFolder, "keys")))
            .SetApplicationName("TraMslate");

        // ── Identity ──────────────────────────────────────────────
        builder.Services.AddIdentity<ApplicationUser, IdentityRole>(o =>
        {
            o.SignIn.RequireConfirmedAccount = false;
            o.Password.RequireDigit = true;
            o.Password.RequiredLength = 8;
            o.Password.RequireUppercase = false;
            o.Password.RequireNonAlphanumeric = false;
        })
        .AddEntityFrameworkStores<AppDbContext>()
        .AddDefaultTokenProviders();

        // ── Auth cookie behaviour ─────────────────────────────────
        builder.Services.ConfigureApplicationCookie(o =>
        {
            o.LoginPath = "/login";
            o.LogoutPath = "/logout";
            o.AccessDeniedPath = "/login";
            // The editor talks to the server with fetch(). A redirect to the login
            // page would arrive as a 200 full of HTML and read as a garbled save, so
            // those requests get a plain 401/403 the editor can explain instead.
            static bool IsEditorApi(HttpRequest r) =>
                r.Headers.Accept.Any(a => a != null && a.Contains("application/json"))
                || r.Headers.ContainsKey("X-TraMslate-Api");
            o.Events.OnRedirectToLogin = ctx =>
            {
                if (IsEditorApi(ctx.Request)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return Task.CompletedTask; }
                ctx.Response.Redirect(ctx.RedirectUri);
                return Task.CompletedTask;
            };
            o.Events.OnRedirectToAccessDenied = ctx =>
            {
                if (IsEditorApi(ctx.Request)) { ctx.Response.StatusCode = StatusCodes.Status403Forbidden; return Task.CompletedTask; }
                ctx.Response.Redirect(ctx.RedirectUri);
                return Task.CompletedTask;
            };
        });

        // Who may open which project, and what they may change once inside.
        builder.Services.AddScoped<TraMslate.Services.ProjectAccess>();

        builder.Services.AddControllersWithViews(o =>
            o.Filters.Add(new Microsoft.AspNetCore.Mvc.AutoValidateAntiforgeryTokenAttribute()));

        // Allow large video file uploads
        builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(o =>
        {
            o.MultipartBodyLengthLimit = 2_147_483_648; // 2GB
        });

        builder.WebHost.ConfigureKestrel(o =>
        {
            o.Limits.MaxRequestBodySize = 2_147_483_648; // 2GB
            o.Listen(IPAddress.Loopback, Port);           // this PC only, not the network
        });

        var app = builder.Build();

        // Create the database file and tables on first run.
        using (var scope = app.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();
        }

        if (!app.Environment.IsDevelopment())
        {
            app.UseExceptionHandler("/Home/Error");
        }

        // Uploaded media is served through the ownership-checked Project/Media action.
        app.Use(async (context, next) =>
        {
            if (context.Request.Path.StartsWithSegments("/uploads", StringComparison.OrdinalIgnoreCase))
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            await next(context);
        });
        app.UseStaticFiles();
        app.UseRouting();

        app.UseAuthentication();
        app.UseAuthorization();

        // Account, Dashboard and Project actions are attribute-routed (see their controllers)
        // for short, readable URLs (/login, /dashboard, /studio/5, ...). This conventional
        // route only serves the remaining Home controller actions (e.g. /Home/Privacy).
        app.MapControllerRoute(
            name: "default",
            pattern: "{controller=Home}/{action=Index}/{id?}");

        return app;
    }
}

/// <summary>The desktop window: shows the local pages, no browser or address bar.</summary>
internal sealed class MainWindow : WinForms.Form
{
    private readonly WebView2 _web = new() { Dock = WinForms.DockStyle.Fill };
    private readonly string _startUrl;
    private readonly string _dataFolder;

    public MainWindow(string startUrl, string dataFolder, string? webRoot)
    {
        _startUrl = startUrl;
        _dataFolder = dataFolder;

        Text = "TraMslate";
        WindowState = WinForms.FormWindowState.Maximized;
        MinimumSize = new System.Drawing.Size(1000, 650);

        var iconPath = webRoot is null ? null : Path.Combine(webRoot, "favicon.ico");
        if (iconPath is not null && File.Exists(iconPath))
        {
            try { Icon = new System.Drawing.Icon(iconPath); } catch { /* keep default icon */ }
        }

        Controls.Add(_web);
        Load += async (_, _) => await StartBrowserAsync();
    }

    private async Task StartBrowserAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(_dataFolder, "WebView2"));
            await _web.EnsureCoreWebView2Async(env);

            // Links that try to open a new window: our pages stay here,
            // outside websites open in the normal browser.
            _web.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (e.Uri.StartsWith(_startUrl, StringComparison.OrdinalIgnoreCase))
                    _web.CoreWebView2.Navigate(e.Uri);
                else
                    Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
            };

            _web.Source = new Uri(_startUrl);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            WinForms.MessageBox.Show(
                "This PC is missing the Microsoft Edge WebView2 Runtime.\n\n" +
                "Install it from:\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703\n\nthen open TraMslate again.",
                "TraMslate", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
            Close();
        }
    }
}