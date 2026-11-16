using Godot;
using OneLobby;

namespace OneLobbyDemo;

/// <summary>
/// For the networked player's self-check only: a character that gives its OneLobbyNetPlayer a step function in its own <c>_Ready</c>
/// (what a host-authority game does), so the check can see that the spawner does not overwrite it with nothing.
/// </summary>
public partial class OwnStepCharacter : Node3D
{
    public override void _Ready() => GetNode<OneLobbyNetPlayer>("NetPlayer").StepFunction = (s, _, _) => s;
}
