using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TraMslate.Migrations
{
    /// <inheritdoc />
    public partial class AddCueStatusAndProjectRevision : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Status",
                table: "SubtitleEvents",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "Revision",
                table: "Projects",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTime>(
                name: "UpdatedAt",
                table: "Projects",
                type: "datetime2",
                nullable: false,
                defaultValue: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));

            // Existing projects would otherwise report a last-edited date of
            // year 1, which reads as a bug on the dashboard.
            migrationBuilder.Sql("UPDATE [Projects] SET [UpdatedAt] = [CreatedAt];");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Status",
                table: "SubtitleEvents");

            migrationBuilder.DropColumn(
                name: "Revision",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "UpdatedAt",
                table: "Projects");
        }
    }
}
