using System.Text.Json;
using System.Text.Json.Serialization;

namespace ExportApi.Models;

/// <summary>
/// One NDJSON line emitted by the render CLI on stdout. A single flexible DTO
/// covers every event type (preflight | stage | progress | warning |
/// first-frame | done | error | canceled); unused fields stay null.
/// </summary>
public sealed class RenderEvent
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";

    // stage
    [JsonPropertyName("name")] public string? Name { get; set; }
    // progress
    [JsonPropertyName("value")] public double? Value { get; set; }
    // first-frame
    [JsonPropertyName("ms")] public long? Ms { get; set; }
    // warning / error
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("code")] public string? Code { get; set; }
    // done
    [JsonPropertyName("warnings")] public string[]? Warnings { get; set; }
    // preflight + done.preflight
    [JsonPropertyName("videoCodec")] public string? VideoCodec { get; set; }
    [JsonPropertyName("audioCodec")] public string? AudioCodec { get; set; }
    [JsonPropertyName("risky")] public bool? Risky { get; set; }
    [JsonPropertyName("normalized")] public bool? Normalized { get; set; }
    [JsonPropertyName("videoDecodable")] public bool? VideoDecodable { get; set; }
    [JsonPropertyName("audioDecodable")] public bool? AudioDecodable { get; set; }
    [JsonPropertyName("needsAudioDrop")] public bool? NeedsAudioDrop { get; set; }
    /// <summary>preserved | removed | none — the audio outcome after normalization
    /// (top-level on preflight + done events).</summary>
    [JsonPropertyName("audioStatus")] public string? AudioStatus { get; set; }
    [JsonPropertyName("preflight")] public JsonElement? Preflight { get; set; }

    // version
    [JsonPropertyName("cliVersion")] public string? CliVersion { get; set; }
    [JsonPropertyName("build")] public string? Build { get; set; }
    [JsonPropertyName("node")] public string? Node { get; set; }
    // render-input (the pre-render contract)
    [JsonPropertyName("inputFile")] public string? InputFile { get; set; }
    [JsonPropertyName("normalizedFile")] public string? NormalizedFile { get; set; }
    [JsonPropertyName("renderSource")] public string? RenderSource { get; set; }
    [JsonPropertyName("wasNormalizationRun")] public bool? WasNormalizationRun { get; set; }

    public static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>Parse one NDJSON line; null if it isn't valid JSON (non-fatal — logged + skipped).</summary>
    public static RenderEvent? TryParse(string line)
    {
        try { return JsonSerializer.Deserialize<RenderEvent>(line, JsonOpts); }
        catch { return null; }
    }
}
