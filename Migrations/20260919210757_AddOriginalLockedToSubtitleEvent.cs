using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TraMslate.Migrations
{
    /// <inheritdoc />
    public partial class AddOriginalLockedToSubtitleEvent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "OriginalLocked",
                table: "SubtitleEvents",
                type: "bit",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "OriginalLocked",
                table: "SubtitleEvents");
        }
    }
}
