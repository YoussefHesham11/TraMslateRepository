using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using TraMslate.Models;

namespace TraMslate.Data
{
    public class AppDbContext : IdentityDbContext<ApplicationUser>
    {
        public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

        public DbSet<Project> Projects { get; set; }
        public DbSet<SubtitleEvent> SubtitleEvents { get; set; }
        public DbSet<UserShortcut> UserShortcuts { get; set; }
        public DbSet<ProjectMember> ProjectMembers { get; set; }
        public DbSet<ReviewRound> ReviewRounds { get; set; }

        protected override void OnModelCreating(ModelBuilder builder)
        {
            base.OnModelCreating(builder);

            builder.Entity<Project>()
                .HasOne(p => p.User)
                .WithMany(u => u.Projects)
                .HasForeignKey(p => p.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            builder.Entity<SubtitleEvent>()
                .HasOne(s => s.Project)
                .WithMany(p => p.SubtitleEvents)
                .HasForeignKey(s => s.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);

            builder.Entity<UserShortcut>()
                .HasOne(s => s.User)
                .WithMany(u => u.Shortcuts)
                .HasForeignKey(s => s.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            builder.Entity<UserShortcut>()
                .HasIndex(s => new { s.UserId, s.FunctionId })
                .IsUnique();

            builder.Entity<ProjectMember>()
                .HasOne(m => m.Project)
                .WithMany(p => p.Members)
                .HasForeignKey(m => m.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);

            // Deleting the account deletes the project it owns, which would
            // cascade to this row as well; SQL Server refuses two cascade paths
            // to one table, so this side is cut manually in the controller.
            builder.Entity<ProjectMember>()
                .HasOne(m => m.User)
                .WithMany(u => u.Memberships)
                .HasForeignKey(m => m.UserId)
                .OnDelete(DeleteBehavior.Restrict);

            // One person holds one role on a project.
            builder.Entity<ProjectMember>()
                .HasIndex(m => new { m.ProjectId, m.UserId })
                .IsUnique();

            builder.Entity<ReviewRound>()
                .HasOne(r => r.Project)
                .WithMany(p => p.ReviewRounds)
                .HasForeignKey(r => r.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);

            builder.Entity<ReviewRound>()
                .HasOne(r => r.Reviewer)
                .WithMany()
                .HasForeignKey(r => r.ReviewerId)
                .OnDelete(DeleteBehavior.Restrict);

            builder.Entity<ReviewRound>()
                .HasIndex(r => new { r.ProjectId, r.Number })
                .IsUnique();
        }
    }
}