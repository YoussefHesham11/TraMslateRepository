namespace TraMslate.Models
{
    // One custom keyboard shortcut override for one user. A missing row for a
    // given (UserId, FunctionId) means "use the built-in default shortcut".
    // KeyCombo can be an empty string, meaning the user explicitly unbound it.
    public class UserShortcut
    {
        public int Id { get; set; }
        public string UserId { get; set; } = string.Empty;
        public ApplicationUser? User { get; set; }
        public string FunctionId { get; set; } = string.Empty;
        public string KeyCombo { get; set; } = string.Empty;
    }
}
