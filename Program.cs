using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using TraMslate.Data;
using TraMslate.Models;

var builder = WebApplication.CreateBuilder(args);

// ── Database ──────────────────────────────────────────────
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));

// ── Identity ──────────────────────────────────────────────
builder.Services.AddIdentity<ApplicationUser, IdentityRole>(options =>
{
    options.SignIn.RequireConfirmedAccount = false;
    options.Password.RequireDigit = true;
    options.Password.RequiredLength = 8;
    options.Password.RequireUppercase = false;
    options.Password.RequireNonAlphanumeric = false;
})
.AddEntityFrameworkStores<AppDbContext>()
.AddDefaultTokenProviders();

// ── Auth cookie behaviour ─────────────────────────────────
builder.Services.ConfigureApplicationCookie(options =>
{
    options.LoginPath = "/login";
    options.LogoutPath = "/logout";
    options.AccessDeniedPath = "/login";
    // The editor talks to the server with fetch(). A redirect to the login
    // page would arrive as a 200 full of HTML and read as a garbled save, so
    // those requests get a plain 401/403 the editor can explain instead.
    static bool IsEditorApi(HttpRequest r) =>
        r.Headers.Accept.Any(a => a != null && a.Contains("application/json"))
        || r.Headers.ContainsKey("X-TraMslate-Api");
    options.Events.OnRedirectToLogin = ctx =>
    {
        if (IsEditorApi(ctx.Request)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return Task.CompletedTask; }
        ctx.Response.Redirect(ctx.RedirectUri);
        return Task.CompletedTask;
    };
    options.Events.OnRedirectToAccessDenied = ctx =>
    {
        if (IsEditorApi(ctx.Request)) { ctx.Response.StatusCode = StatusCodes.Status403Forbidden; return Task.CompletedTask; }
        ctx.Response.Redirect(ctx.RedirectUri);
        return Task.CompletedTask;
    };
});

// Who may open which project, and what they may change once inside.
builder.Services.AddScoped<TraMslate.Services.ProjectAccess>();

builder.Services.AddControllersWithViews(options =>
    options.Filters.Add(new Microsoft.AspNetCore.Mvc.AutoValidateAntiforgeryTokenAttribute()));

// Allow large video file uploads
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 2_147_483_648; // 2GB
});

builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 2_147_483_648; // 2GB
});

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    app.UseHsts();
}

app.UseHttpsRedirection();
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

app.Run();
