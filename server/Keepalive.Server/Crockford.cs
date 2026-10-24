namespace Keepalive.Server;

/// <summary>Crockford Base32 join codes (DESIGN s.6): no I L O U, case-insensitive, i/l to 1, o to 0.</summary>
public static class Crockford
{
    public const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    public const int Length = 6;

    public static string Generate(Func<int, int> nextInt)
    {
        Span<char> c = stackalloc char[Length];
        for (int i = 0; i < Length; i++) c[i] = Alphabet[nextInt(Alphabet.Length)];
        return new string(c);
    }

    /// <summary>Normalises typed input ("7hq 4k2", "7HQ-4K2") to canonical form, or null if invalid.</summary>
    public static string? Normalize(string? input)
    {
        if (input is null) return null;
        Span<char> c = stackalloc char[Length];
        int n = 0;
        foreach (char raw in input)
        {
            if (raw == ' ' || raw == '-') continue;
            char ch = raw is >= 'a' and <= 'z' ? (char)(raw - 32) : raw; // ASCII-only uppercasing
            if (ch == 'I' || ch == 'L') ch = '1';
            else if (ch == 'O') ch = '0';
            if (Alphabet.IndexOf(ch) < 0 || n >= Length) return null;
            c[n++] = ch;
        }
        return n == Length ? new string(c) : null;
    }
}
