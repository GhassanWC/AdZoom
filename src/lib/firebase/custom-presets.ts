"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebase } from "./client";
import type { EffectsSettings, Preset, PresetCategory, PresetVibe } from "./schema";

interface PersistedPreset {
  name: string;
  description: string;
  useCase: string;
  category: PresetCategory;
  vibe: PresetVibe;
  effects: EffectsSettings;
  basedOn?: string;
  createdAt: ReturnType<typeof serverTimestamp>;
  updatedAt: ReturnType<typeof serverTimestamp>;
}

function presetsCol(uid: string) {
  const { db } = getFirebase();
  return collection(db, "users", uid, "presets");
}

export function subscribeCustomPresets(
  uid: string,
  onChange: (presets: Preset[]) => void
): Unsubscribe {
  const q = query(presetsCol(uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => {
    onChange(
      snap.docs.map((d) => materializePreset(uid, d.id, d.data() as Record<string, unknown>))
    );
  });
}

export async function createCustomPreset(
  uid: string,
  input: {
    name: string;
    description?: string;
    useCase?: string;
    category: PresetCategory;
    vibe: PresetVibe;
    effects: EffectsSettings;
    basedOn?: string;
  }
): Promise<string> {
  const payload: PersistedPreset = {
    name: input.name,
    description: input.description ?? "",
    useCase: input.useCase ?? "",
    category: input.category,
    vibe: input.vibe,
    effects: input.effects,
    basedOn: input.basedOn,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const created = await addDoc(presetsCol(uid), payload);
  return created.id;
}

export async function updateCustomPreset(
  uid: string,
  id: string,
  patch: Partial<Pick<PersistedPreset, "name" | "description" | "useCase" | "category" | "vibe" | "effects">>
) {
  const { db } = getFirebase();
  await updateDoc(doc(db, "users", uid, "presets", id), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteCustomPreset(uid: string, id: string) {
  const { db } = getFirebase();
  await deleteDoc(doc(db, "users", uid, "presets", id));
}

function materializePreset(
  uid: string,
  id: string,
  data: Record<string, unknown>
): Preset {
  const createdAt = (data.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.();
  const updatedAt = (data.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.();
  return {
    id,
    name: (data.name as string) ?? "Untitled preset",
    description: (data.description as string) ?? "",
    useCase: (data.useCase as string) ?? "",
    category: (data.category as PresetCategory) ?? "Creator",
    vibe: (data.vibe as PresetVibe) ?? "cinematic",
    effects: (data.effects as EffectsSettings),
    isCustom: true,
    ownerUid: uid,
    basedOn: data.basedOn as string | undefined,
    createdAt,
    updatedAt,
  };
}
