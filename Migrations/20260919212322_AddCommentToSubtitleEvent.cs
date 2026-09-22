using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TraMslate.Migrations
{
    /// <inheritdoc />
    public partial class AddCommentToSubtitleEvent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Comment",
                table: "SubtitleEvents",
                type: "nvarchar(max)",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Comment",
                table: "SubtitleEvents");
        }
    }
}
