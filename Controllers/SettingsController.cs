using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TraMslate.Data;
using TraMslate.Models;

namespace TraMslate.Controllers
{
    [Authorize]
    [Route("settings/shortcuts")]
    public class SettingsController : Controller
    {
        private readonly AppDbContext _db;
        private readonly UserManager<ApplicationUser> _userManager;

        public SettingsController(AppDbContext db, UserManager<ApplicationUser> userManager)
        {
            _db = db;
            _userManager = userManager;
        }

        // ── Page ──────────────────────────────────────────
        [HttpGet("")]
        public IActionResult Shortcuts() => View();

        // ── Current overrides for this user ──────────────
        [HttpGet("data")]
        public async Task<IActionResult> Data()
        {
            var userId = _userManager.GetUserId(User);
            var overrides = await _db.UserShortcuts
                .Where(s => s.UserId == userId)
                .ToDictionaryAsync(s => s.FunctionId, s => s.KeyCombo);

            return Json(new { overrides });
        }

        public class ShortcutSaveDto
        {
            public string FunctionId { get; set; } = string.Empty;
            public string KeyCombo { get; set; } = string.Empty;
        }

        // ── Save a batch of changed shortcuts ────────────
        [HttpPost("save")]
        public async Task<IActionResult> Save([FromBody] List<ShortcutSaveDto>? items)
        {
            var userId = _userManager.GetUserId(User);
            if (userId == null) return Unauthorized();
            if (items == null || items.Count == 0) return Json(new { success = true });

            var ids = items.Select(i => i.FunctionId).ToList();
            var existing = await _db.UserShortcuts
                .Where(s => s.UserId == userId && ids.Contains(s.FunctionId))
                .ToDictionaryAsync(s => s.FunctionId);

            foreach (var item in items)
            {
                if (string.IsNullOrWhiteSpace(item.FunctionId)) continue;
                if (existing.TryGetValue(item.FunctionId, out var row))
                {
                    row.KeyCombo = item.KeyCombo ?? string.Empty;
                }
                else
                {
                    _db.UserShortcuts.Add(new UserShortcut
                    {
                        UserId = userId,
                        FunctionId = item.FunctionId,
                        KeyCombo = item.KeyCombo ?? string.Empty
                    });
                }
            }

            await _db.SaveChangesAsync();
            return Json(new { success = true });
        }

        // ── Reset one function (functionId given) or all (omitted) to default ──
        [HttpPost("reset")]
        public async Task<IActionResult> Reset([FromForm] string? functionId)
        {
            var userId = _userManager.GetUserId(User);
            if (userId == null) return Unauthorized();

            var query = _db.UserShortcuts.Where(s => s.UserId == userId);
            if (!string.IsNullOrEmpty(functionId))
                query = query.Where(s => s.FunctionId == functionId);

            _db.UserShortcuts.RemoveRange(query);
            await _db.SaveChangesAsync();
            return Json(new { success = true });
        }
    }
}
