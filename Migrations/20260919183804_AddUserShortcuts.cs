using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TraMslate.Migrations
{
    /// <inheritdoc />
    public partial class AddUserShortcuts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "UserShortcuts",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    UserId = table.Column<string>(type: "nvarchar(450)", nullable: false),
                    FunctionId = table.Column<string>(type: "nvarchar(450)", nullable: false),
                    KeyCombo = table.Column<string>(type: "nvarchar(max)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserShortcuts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_UserShortcuts_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserShortcuts_UserId_FunctionId",
                table: "UserShortcuts",
                columns: new[] { "UserId", "FunctionId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserShortcuts");
        }
    }
}
