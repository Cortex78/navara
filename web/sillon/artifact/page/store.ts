import { closedCoords, openRing, type Ring } from "../../src/field/geometry";

/*
 * The viewer's saved fields, in the artifact's database under their own
 * `data/users/<id>/` collection: private to them, the artifact's owner
 * included, and kept across visits and new versions of the page.
 */

export type SavedField = {
  id: string;
  name: string;
  ring: Ring;
  areaHa: number;
  crop: string | null;
  savedAt: string;
};

type DbError = { code: string; message: string };
type DocSnap = { id: string; data(): Record<string, unknown> | undefined };
type QuerySnap = { docs: DocSnap[]; metadata: { fromCache: boolean } };
type DocRef = {
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
};
type Collection = {
  doc(id?: string): DocRef & { id: string };
  orderBy(
    field: string,
    dir?: "asc" | "desc",
  ): {
    onSnapshot(
      next: (s: QuerySnap) => void,
      error?: (e: DbError) => void,
    ): () => void;
  };
};
type Db = { collection(path: string): Collection };
type User = { id(): Promise<string | null> };
type Host = { use(name: string): Promise<unknown> };

export type FieldStore = {
  /** Calls `onList` with every saved field, now and after each change. */
  subscribe(
    onList: (fields: SavedField[], confirmed: boolean) => void,
    onError: (message: string) => void,
  ): () => void;
  /** Creates or replaces a field; resolves its id. */
  save(
    field: Omit<SavedField, "id" | "savedAt"> & { id?: string },
  ): Promise<string>;
  remove(id: string): Promise<void>;
};

const describe = (e: unknown) => {
  const code = (e as DbError)?.code;
  if (code === "quota_exceeded")
    return "Your saved fields are full. Delete some to save more.";
  if (code === "invalid_argument")
    return "This view of the page cannot save fields (view-only access).";
  if (code === "revoked" || code === "not_granted")
    return "Saving fields is not available in this view.";
  return "Saved fields could not be reached. Try again in a moment.";
};

const parse = (snap: DocSnap): SavedField | null => {
  const d = snap.data();
  if (!d || typeof d.ring !== "string") return null;
  try {
    const ring = openRing(JSON.parse(d.ring) as number[][]);
    if (ring.length < 3) return null;
    return {
      id: snap.id,
      name: typeof d.name === "string" ? d.name : "Field",
      ring,
      areaHa: typeof d.areaHa === "number" ? d.areaHa : 0,
      crop: typeof d.crop === "string" ? d.crop : null,
      savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
    };
  } catch {
    return null;
  }
};

/** The viewer's field store, or null where this view has no private storage. */
export const openFieldStore = async (): Promise<FieldStore | null> => {
  const host = (window as unknown as { claude?: Host }).claude;
  if (!host?.use) return null;
  const [db, user] = (await Promise.all([
    host.use("db").catch(() => null),
    host.use("user").catch(() => null),
  ])) as [Db | null, User | null];
  if (!db || !user) return null;
  const uid = await user.id().catch(() => null);
  if (!uid) return null;
  const fields = db.collection(`data/users/${uid}`);
  return {
    subscribe(onList, onError) {
      return fields.orderBy("savedAt", "desc").onSnapshot(
        (snap) =>
          onList(
            snap.docs.map(parse).filter((f): f is SavedField => f !== null),
            !snap.metadata.fromCache,
          ),
        (e) => onError(describe(e)),
      );
    },
    async save({ id, name, ring, areaHa, crop }) {
      const ref = id ? fields.doc(id) : fields.doc();
      try {
        await ref.set({
          name,
          // Nested arrays are kept as text: the store takes plain objects.
          ring: JSON.stringify(
            closedCoords(ring).map(([lng, lat]) => [
              Math.round(lng * 1e8) / 1e8,
              Math.round(lat * 1e8) / 1e8,
            ]),
          ),
          areaHa,
          crop,
          savedAt: new Date().toISOString(),
        });
      } catch (e) {
        throw new Error(describe(e), { cause: e });
      }
      return ref.id;
    },
    async remove(id) {
      try {
        await fields.doc(id).delete();
      } catch (e) {
        throw new Error(describe(e), { cause: e });
      }
    },
  };
};
