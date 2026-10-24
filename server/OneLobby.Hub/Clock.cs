namespace OneLobby.Server;

/// <summary>Injected time source (unix milliseconds) so tests can drive time deterministically.</summary>
public interface IClock
{
    long NowMs { get; }
}

public sealed class SystemClock : IClock
{
    public long NowMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}
