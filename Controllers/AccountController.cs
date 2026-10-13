using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using TraMslate.Models;
using TraMslate.ViewModels;

namespace TraMslate.Controllers
{
    public class AccountController : Controller
    {
        private readonly UserManager<ApplicationUser> _userManager;
        private readonly SignInManager<ApplicationUser> _signInManager;

        public AccountController(UserManager<ApplicationUser> userManager,
                                 SignInManager<ApplicationUser> signInManager)
        {
            _userManager = userManager;
            _signInManager = signInManager;
        }

        // ── Register ──────────────────────────────────────
        [HttpGet("register")]
        public IActionResult Register()
        {
            if (_signInManager.IsSignedIn(User)) return RedirectToAction("Index", "Dashboard");
            return View();
        }

        [HttpPost("register")]
        public async Task<IActionResult> Register(RegisterViewModel model)
        {
            if (!ModelState.IsValid) return View(model);

            var user = new ApplicationUser
            {
                FullName = model.FullName,
                UserName = model.Email,
                Email = model.Email,
                LanguageSpecialty = model.LanguageSpecialty
            };

            var result = await _userManager.CreateAsync(user, model.Password);

            if (result.Succeeded)
            {
                await _signInManager.SignInAsync(user, isPersistent: false);
                return RedirectToAction("Index", "Dashboard");
            }

            foreach (var error in result.Errors)
                ModelState.AddModelError(string.Empty, error.Description);

            return View(model);
        }

        // ── Login ─────────────────────────────────────────
        [HttpGet("")]
        [HttpGet("login")]
        public IActionResult Login()
        {
            if (_signInManager.IsSignedIn(User)) return RedirectToAction("Index", "Dashboard");
            return View();
        }

        [HttpPost("login")]
        public async Task<IActionResult> Login(LoginViewModel model)
        {
            if (!ModelState.IsValid) return View(model);

            // Repeated wrong passwords lock the account for a few minutes, so a
            // password cannot be guessed by trying many in a row.
            var result = await _signInManager.PasswordSignInAsync(
                model.Email, model.Password, model.RememberMe, lockoutOnFailure: true);

            if (result.Succeeded)
                return RedirectToAction("Index", "Dashboard");

            ModelState.AddModelError(string.Empty, result.IsLockedOut
                ? "Too many failed sign-in attempts. Wait a few minutes, then try again."
                : "Invalid email or password.");
            return View(model);
        }

        // ── Account ───────────────────────────────────────
        [Authorize]
        [HttpGet("account")]
        public async Task<IActionResult> Manage()
        {
            var user = await _userManager.GetUserAsync(User);
            if (user == null) return RedirectToAction(nameof(Login));
            return View(ManageModel(user));
        }

        [Authorize]
        [HttpPost("account/profile")]
        public async Task<IActionResult> UpdateProfile([Bind(Prefix = "Profile")] ProfileViewModel profile)
        {
            var user = await _userManager.GetUserAsync(User);
            if (user == null) return RedirectToAction(nameof(Login));
            if (!ModelState.IsValid)
            {
                var model = ManageModel(user);
                model.Profile = profile;
                return View(nameof(Manage), model);
            }

            user.FullName = profile.FullName.Trim();
            user.LanguageSpecialty = string.IsNullOrWhiteSpace(profile.LanguageSpecialty) ? null : profile.LanguageSpecialty.Trim();
            await _userManager.UpdateAsync(user);
            TempData["AccountNotice"] = "Profile saved.";
            return RedirectToAction(nameof(Manage));
        }

        [Authorize]
        [HttpPost("account/password")]
        public async Task<IActionResult> ChangePassword([Bind(Prefix = "Password")] ChangePasswordViewModel password)
        {
            var user = await _userManager.GetUserAsync(User);
            if (user == null) return RedirectToAction(nameof(Login));

            if (ModelState.IsValid)
            {
                var result = await _userManager.ChangePasswordAsync(user, password.CurrentPassword, password.NewPassword);
                if (result.Succeeded)
                {
                    // Refreshing the sign-in keeps this session valid after the
                    // security stamp changes.
                    await _signInManager.RefreshSignInAsync(user);
                    TempData["AccountNotice"] = "Password changed.";
                    return RedirectToAction(nameof(Manage));
                }
                foreach (var error in result.Errors)
                    ModelState.AddModelError(string.Empty, error.Code == "PasswordMismatch"
                        ? "Your current password is not correct."
                        : error.Description);
            }
            return View(nameof(Manage), ManageModel(user));
        }

        private static ManageAccountViewModel ManageModel(ApplicationUser user) => new()
        {
            Email = user.Email ?? string.Empty,
            Profile = new ProfileViewModel { FullName = user.FullName, LanguageSpecialty = user.LanguageSpecialty },
        };

        // ── Logout ────────────────────────────────────────
        [HttpPost("logout")]
        public async Task<IActionResult> Logout()
        {
            await _signInManager.SignOutAsync();
            return RedirectToAction("Login");
        }
    }
}