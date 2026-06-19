using System.Security.Cryptography;
using System.Text;
using ExportApi.Models;

namespace ExportApi.Auth;

/// <summary>
/// Authenticates every request except /health with a shared secret in the
/// `X-Internal-Secret` header (constant-time compare). The Next.js front door
/// verified the Firebase token and forwards the trusted `uid` in the request;
/// C# does NOT verify Firebase tokens. Fails closed when the secret is unset.
/// </summary>
public sealed class InternalSecretMiddleware(RequestDelegate next, ExportOptions opts)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        if (ctx.Request.Path.StartsWithSegments("/health"))
        {
            await next(ctx);
            return;
        }

        var expected = opts.InternalSecret;
        var got = ctx.Request.Headers["X-Internal-Secret"].ToString();
        if (string.IsNullOrEmpty(expected) || !FixedEquals(expected, got))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await ctx.Response.WriteAsJsonAsync(new { error = "unauthorized" });
            return;
        }
        await next(ctx);
    }

    private static bool FixedEquals(string a, string b)
    {
        var ba = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return ba.Length == bb.Length && CryptographicOperations.FixedTimeEquals(ba, bb);
    }
}
