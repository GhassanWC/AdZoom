using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ExportApi.Services;

/// <summary>
/// Deterministic dedup key for an export — the C# mirror of
/// src/lib/export/settings-hash.ts. Two enqueue requests with identical inputs
/// (project + source object + format/resolution/fps + the opaque render recipe,
/// which carries canvas/vignette/timeline) produce the same hash, so the create
/// path can recognise a repeated submit as a duplicate of an already-active job.
///
/// Note: this does NOT need to byte-match the TypeScript hash — in production a
/// single creator (Next.js `createCloudExportJob`) owns dedup; this is the safety
/// net for the C# standalone CREATE path, so self-consistency is what matters.
/// </summary>
public static class SettingsHash
{
    public static string Compute(
        string projectId,
        string sourceObjectPath,
        string? format,
        string? resolution,
        int fps,
        JsonElement serializedRecipe)
    {
        var canonical = new StringBuilder()
            .Append(projectId).Append('|')
            .Append(sourceObjectPath).Append('|')
            .Append(format ?? "").Append('|')
            .Append(resolution ?? "").Append('|')
            .Append(fps).Append('|')
            .Append(CanonicalJson(serializedRecipe))
            .ToString();
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexString(bytes).ToLowerInvariant()[..16];
    }

    /// <summary>Stable JSON: object keys sorted recursively so equal data → equal string.</summary>
    private static string CanonicalJson(JsonElement el)
    {
        var sb = new StringBuilder();
        Write(el, sb);
        return sb.ToString();
    }

    private static void Write(JsonElement el, StringBuilder sb)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
                sb.Append('{');
                var first = true;
                foreach (var prop in el.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(JsonSerializer.Serialize(prop.Name)).Append(':');
                    Write(prop.Value, sb);
                }
                sb.Append('}');
                break;
            case JsonValueKind.Array:
                sb.Append('[');
                var firstA = true;
                foreach (var item in el.EnumerateArray())
                {
                    if (!firstA) sb.Append(',');
                    firstA = false;
                    Write(item, sb);
                }
                sb.Append(']');
                break;
            case JsonValueKind.String:
                sb.Append(JsonSerializer.Serialize(el.GetString()));
                break;
            case JsonValueKind.Number:
                sb.Append(el.GetRawText());
                break;
            case JsonValueKind.True:
                sb.Append("true");
                break;
            case JsonValueKind.False:
                sb.Append("false");
                break;
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
            default:
                sb.Append("null");
                break;
        }
    }
}
