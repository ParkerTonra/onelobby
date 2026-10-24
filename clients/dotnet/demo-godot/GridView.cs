using System;
using Godot;
using Keepalive.Gridpaint;

namespace KeepaliveDemo;

/// <summary>Draws the 16x16 gridpaint board and reports clicked cells.</summary>
public partial class GridView : Control
{
    private static readonly Color[] Palette =
    {
        new("000000"), new("e6194b"), new("3cb44b"), new("ffe119"), new("4363d8"), new("f58231"), new("911eb4"), new("46f0f0"),
        new("f032e6"), new("bcf60c"), new("fabebe"), new("008080"), new("e6beff"), new("9a6324"), new("800000"), new("aaffc3"),
    };

    public GridpaintGame? Game;
    public Action<int, int>? CellClicked;

    public override void _Ready()
    {
        CustomMinimumSize = new Vector2(384, 384);
    }

    public override void _Draw()
    {
        var cell = Mathf.Min(Size.X, Size.Y) / GridpaintGame.Size;
        DrawRect(new Rect2(0, 0, cell * GridpaintGame.Size, cell * GridpaintGame.Size), new Color("20232a"));
        if (Game != null)
        {
            var grid = Game.Grid;
            for (var y = 0; y < GridpaintGame.Size; y++)
                for (var x = 0; x < GridpaintGame.Size; x++)
                {
                    var c = grid[y * GridpaintGame.Size + x];
                    if (c == 0) continue;
                    DrawRect(new Rect2(x * cell, y * cell, cell, cell), Palette[c]);
                }
        }
        for (var i = 0; i <= GridpaintGame.Size; i++)
        {
            DrawLine(new Vector2(i * cell, 0), new Vector2(i * cell, GridpaintGame.Size * cell), new Color(1, 1, 1, 0.08f));
            DrawLine(new Vector2(0, i * cell), new Vector2(GridpaintGame.Size * cell, i * cell), new Color(1, 1, 1, 0.08f));
        }
    }

    public override void _GuiInput(InputEvent @event)
    {
        if (@event is InputEventMouseButton { Pressed: true, ButtonIndex: MouseButton.Left } mb)
        {
            var cell = Mathf.Min(Size.X, Size.Y) / GridpaintGame.Size;
            var x = (int)(mb.Position.X / cell);
            var y = (int)(mb.Position.Y / cell);
            if (x >= 0 && y >= 0 && x < GridpaintGame.Size && y < GridpaintGame.Size) CellClicked?.Invoke(x, y);
        }
    }
}
