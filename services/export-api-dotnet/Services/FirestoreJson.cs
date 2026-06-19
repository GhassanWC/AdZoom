using System.Text.Json;

namespace ExportApi.Services;

/// <summary>
/// Convert an arbitrary JSON value (the opaque `serializedRecipe`) into the
/// object graph the Firestore .NET SDK can store (Dictionary / List / string /
/// long / double / bool / null). C# never interprets the recipe — it only
/// stores it on the job doc and forwards it to the render CLI.
/// </summary>
public static class FirestoreJson
{
    public static object? Convert(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Object => el.EnumerateObject()
            .ToDictionary(p => p.Name, p => Convert(p.Value)),
        JsonValueKind.Array => el.EnumerateArray().Select(Convert).ToList(),
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out var l) ? l : el.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        _ => null,
    };
}
