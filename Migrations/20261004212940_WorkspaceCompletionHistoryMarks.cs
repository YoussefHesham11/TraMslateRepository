using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TraMslate.Migrations
{
    /// <inheritdoc />
    public partial class WorkspaceCompletionHistoryMarks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "Bookmarked",
                table: "SubtitleEvents",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "CommentResolved",
                table: "SubtitleEvents",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "Flags",
                table: "SubtitleEvents",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "ReviewState",
                table: "SubtitleEvents",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "WaiversJson",
                table: "SubtitleEvents",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "CompletedAt",
                table: "Projects",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CompletedById",
                table: "Projects",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "CompletedRevision",
                table: "Projects",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CompletionSummary",
                table: "Projects",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastSaveId",
                table: "Projects",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastSaveResultJson",
                table: "Projects",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SettingsJson",
                table: "Projects",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "ProjectSnapshots",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ProjectId = table.Column<int>(type: "int", nullable: false),
                    Revision = table.Column<int>(type: "int", nullable: false),
                    Kind = table.Column<int>(type: "int", nullable: false),
                    Label = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UserId = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    EventsJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    SettingsJson = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CueCount = table.Column<int>(type: "int", nullable: false),
                    TranslatedCount = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProjectSnapshots", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProjectSnapshots_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ProjectSnapshots_ProjectId_CreatedAt",
                table: "ProjectSnapshots",
                columns: new[] { "ProjectId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ProjectSnapshots");

            migrationBuilder.DropColumn(
                name: "Bookmarked",
                table: "SubtitleEvents");

            migrationBuilder.DropColumn(
                name: "CommentResolved",
                table: "SubtitleEvents");

            migrationBuilder.DropColumn(
                name: "Flags",
                table: "SubtitleEvents");

            migrationBuilder.DropColumn(
                name: "ReviewState",
                table: "SubtitleEvents");

            migrationBuilder.DropColumn(
                name: "WaiversJson",
                table: "SubtitleEvents");

            migrationBuilder.DropColumn(
                name: "CompletedAt",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "CompletedById",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "CompletedRevision",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "CompletionSummary",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "LastSaveId",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "LastSaveResultJson",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "SettingsJson",
                table: "Projects");
        }
    }
}
