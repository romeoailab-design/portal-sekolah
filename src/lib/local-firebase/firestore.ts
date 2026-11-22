export type DocumentData = Record<string, any>;
export type WhereFilterOp = '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'array-contains-any' | 'not-in';
export type OrderByDirection = 'asc' | 'desc';
export type Unsubscribe = () => void;

export interface Firestore {
  type: 'mysql-firestore';
}

export interface SetOptions {
  merge?: boolean;
  mergeFields?: string[];
}

export interface CollectionReference<T = DocumentData> {
  type: 'collection';
  id: string;
  path: string;
  _path: { segments: string[] };
  __phantom?: T;
}

export interface DocumentReference<T = DocumentData> {
  type: 'document';
  id: string;
  path: string;
  parent: CollectionReference<T>;
  _key: { path: { segments: string[] } };
  __phantom?: T;
}

export interface QueryConstraint {
  type: 'where' | 'orderBy' | 'limit';
  field?: string;
  op?: WhereFilterOp;
  value?: any;
  direction?: OrderByDirection;
}

export interface Query<T = DocumentData> {
  type: 'query';
  collectionPath: string;
  id: string;
  constraints: QueryConstraint[];
  _query: { path: { segments: string[] } };
  __phantom?: T;
}

export interface DocumentSnapshot<T = DocumentData> {
  id: string;
  exists: () => boolean;
  data: () => T | undefined;
  ref: DocumentReference<T>;
}

export interface QueryDocumentSnapshot<T = DocumentData> {
  id: string;
  exists: () => true;
  data: () => T;
  ref: DocumentReference<T>;
}

export interface QuerySnapshot<T = DocumentData> {
  docs: QueryDocumentSnapshot<T>[];
  empty: boolean;
  size: number;
  forEach: (callback: (doc: QueryDocumentSnapshot<T>) => void) => void;
}

export class Timestamp {
  seconds: number;
  nanoseconds: number;

  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }

  toDate(): Date {
    return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000));
  }

  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000);
  }

  valueOf(): number {
    return this.toMillis();
  }

  toJSON() {
    return {
      __firestoreTimestamp: true,
      seconds: this.seconds,
      nanoseconds: this.nanoseconds,
    };
  }

  static now(): Timestamp {
    const ms = Date.now();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }

  static fromDate(date: Date): Timestamp {
    const ms = date.getTime();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }

  static fromMillis(ms: number): Timestamp {
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }
}

const defaultDb: Firestore = { type: 'mysql-firestore' };

// Lightweight local pub/sub to refresh active onSnapshot listeners immediately after writes
type ChangeListener = () => void;
const collectionListeners = new Map<string, Set<ChangeListener>>();

function emitCollectionChange(collectionPath: string) {
  const set = collectionListeners.get(collectionPath);
  if (!set) return;
  set.forEach((fn) => {
    try {
      fn();
    } catch {
      // ignore
    }
  });
}

function hydrateData(val: any): any {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(hydrateData);
  if (typeof val === 'object') {
    if (
      val.__firestoreTimestamp === true ||
      (typeof val.seconds === 'number' &&
        typeof val.nanoseconds === 'number' &&
        Object.keys(val).every((k) => k === 'seconds' || k === 'nanoseconds' || k === '__firestoreTimestamp'))
    ) {
      return new Timestamp(val.seconds, val.nanoseconds);
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = hydrateData(v);
    }
    return out;
  }
  return val;
}

function serializeData(val: any): any {
  if (val === null || val === undefined) return val;
  if (val instanceof Timestamp) {
    return val.toJSON();
  }
  if (val instanceof Date) {
    return Timestamp.fromDate(val).toJSON();
  }
  if (Array.isArray(val)) return val.map(serializeData);
  if (typeof val === 'object') {
    if (val.__firestoreSentinel) return val;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        out[k] = serializeData(v);
      }
    }
    return out;
  }
  return val;
}

function generateClientId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = new Uint8Array(20);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 20; i++) {
      result += chars[bytes[i] % chars.length];
    }
  } else {
    for (let i = 0; i < 20; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return result;
}

async function apiPost<T = any>(endpoint: string, payload: Record<string, any>): Promise<T> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(json?.error || `Database request failed (${res.status})`);
  }
  return json as T;
}

export function getFirestore(_app?: any): Firestore {
  return defaultDb;
}

export function collection<T = DocumentData>(_dbOrRef: any, ...pathSegments: string[]): CollectionReference<T> {
  const segments = pathSegments
    .flatMap((s) => String(s).split('/'))
    .filter(Boolean);
  const fullPath = segments.join('/');
  const id = segments[segments.length - 1] || fullPath;
  return {
    type: 'collection',
    id,
    path: fullPath,
    _path: { segments },
  };
}

export function doc<T = DocumentData>(dbOrColRef: any, ...pathSegments: string[]): DocumentReference<T> {
  if (dbOrColRef && dbOrColRef.type === 'collection') {
    const colRef = dbOrColRef as CollectionReference<T>;
    const docId = pathSegments[0] ? String(pathSegments[0]) : generateClientId();
    return {
      type: 'document',
      id: docId,
      path: `${colRef.path}/${docId}`,
      parent: colRef,
      _key: { path: { segments: [...colRef._path.segments, docId] } },
    };
  }

  const segments = pathSegments
    .flatMap((s) => String(s).split('/'))
    .filter(Boolean);
  const docId = segments.length >= 2 ? segments[segments.length - 1] : generateClientId();
  const colSegments = segments.length >= 2 ? segments.slice(0, -1) : segments;
  const colPath = colSegments.join('/');
  const colRef = collection<T>(defaultDb, colPath);

  return {
    type: 'document',
    id: docId,
    path: `${colPath}/${docId}`,
    parent: colRef,
    _key: { path: { segments: [...colSegments, docId] } },
  };
}

export function where(field: string, op: WhereFilterOp, value: any): QueryConstraint {
  return { type: 'where', field, op, value: serializeData(value) };
}

export function orderBy(field: string, direction: OrderByDirection = 'asc'): QueryConstraint {
  return { type: 'orderBy', field, direction };
}

export function limit(count: number): QueryConstraint {
  return { type: 'limit', value: count };
}

export function query<T = DocumentData>(
  colOrQuery: CollectionReference<T> | Query<T>,
  ...constraints: QueryConstraint[]
): Query<T> {
  if (colOrQuery.type === 'query') {
    return {
      type: 'query',
      collectionPath: colOrQuery.collectionPath,
      id: colOrQuery.id,
      constraints: [...colOrQuery.constraints, ...constraints],
      _query: colOrQuery._query,
    };
  }
  return {
    type: 'query',
    collectionPath: colOrQuery.path,
    id: colOrQuery.id,
    constraints,
    _query: { path: { segments: colOrQuery._path.segments } },
  };
}

export function serverTimestamp(): any {
  return { __firestoreSentinel: 'serverTimestamp' };
}

export function deleteField(): any {
  return { __firestoreSentinel: 'deleteField' };
}

export async function getDoc<T = DocumentData>(docRef: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const res = await apiPost('/api/db/get-doc', {
    collectionPath: docRef.parent.path,
    docId: docRef.id,
  });

  const hydrated = res.exists ? hydrateData(res.data) : undefined;
  return {
    id: docRef.id,
    exists: () => Boolean(res.exists),
    data: () => hydrated as T | undefined,
    ref: docRef,
  };
}

export async function getDocs<T = DocumentData>(
  colOrQuery: CollectionReference<T> | Query<T>
): Promise<QuerySnapshot<T>> {
  const collectionPath = colOrQuery.type === 'query' ? colOrQuery.collectionPath : colOrQuery.path;
  const constraints = colOrQuery.type === 'query' ? colOrQuery.constraints : [];

  const res = await apiPost('/api/db/query', {
    collectionPath,
    constraints,
  });

  const colRef = collection<T>(defaultDb, collectionPath);
  const docs: QueryDocumentSnapshot<T>[] = (res.docs || []).map((item: { id: string; data: any }) => {
    const hydrated = hydrateData(item.data) as T;
    const dRef = doc<T>(colRef, item.id);
    return {
      id: item.id,
      exists: () => true as const,
      data: () => hydrated,
      ref: dRef,
    };
  });

  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb) => docs.forEach(cb),
  };
}

export async function setDoc<T = DocumentData>(
  docRef: DocumentReference<T>,
  data: Partial<T> | DocumentData,
  options?: SetOptions
): Promise<void> {
  await apiPost('/api/db/set-doc', {
    collectionPath: docRef.parent.path,
    docId: docRef.id,
    data: serializeData(data),
    merge: Boolean(options?.merge || options?.mergeFields),
  });
  emitCollectionChange(docRef.parent.path);
}

export async function addDoc<T = DocumentData>(
  colRef: CollectionReference<T>,
  data: T | DocumentData
): Promise<DocumentReference<T>> {
  const res = await apiPost('/api/db/add-doc', {
    collectionPath: colRef.path,
    data: serializeData(data),
  });
  emitCollectionChange(colRef.path);
  return doc<T>(colRef, res.id);
}

export async function updateDoc<T = DocumentData>(
  docRef: DocumentReference<T>,
  data: Partial<T> | DocumentData
): Promise<void> {
  await apiPost('/api/db/update-doc', {
    collectionPath: docRef.parent.path,
    docId: docRef.id,
    data: serializeData(data),
  });
  emitCollectionChange(docRef.parent.path);
}

export async function deleteDoc<T = DocumentData>(docRef: DocumentReference<T>): Promise<void> {
  await apiPost('/api/db/delete-doc', {
    collectionPath: docRef.parent.path,
    docId: docRef.id,
  });
  emitCollectionChange(docRef.parent.path);
}

export interface WriteBatch {
  set: (docRef: DocumentReference<any>, data: DocumentData, options?: SetOptions) => WriteBatch;
  update: (docRef: DocumentReference<any>, data: DocumentData) => WriteBatch;
  delete: (docRef: DocumentReference<any>) => WriteBatch;
  commit: () => Promise<void>;
}

export function writeBatch(_db?: Firestore): WriteBatch {
  const ops: any[] = [];
  const touchedCollections = new Set<string>();

  const batch: WriteBatch = {
    set(docRef, data, options) {
      touchedCollections.add(docRef.parent.path);
      ops.push({
        type: 'set',
        collectionPath: docRef.parent.path,
        docId: docRef.id,
        data: serializeData(data),
        merge: Boolean(options?.merge || options?.mergeFields),
      });
      return batch;
    },
    update(docRef, data) {
      touchedCollections.add(docRef.parent.path);
      ops.push({
        type: 'update',
        collectionPath: docRef.parent.path,
        docId: docRef.id,
        data: serializeData(data),
      });
      return batch;
    },
    delete(docRef) {
      touchedCollections.add(docRef.parent.path);
      ops.push({
        type: 'delete',
        collectionPath: docRef.parent.path,
        docId: docRef.id,
      });
      return batch;
    },
    async commit() {
      if (ops.length === 0) return;
      await apiPost('/api/db/batch', { operations: ops });
      touchedCollections.forEach((col) => emitCollectionChange(col));
    },
  };

  return batch;
}

export function onSnapshot<T = DocumentData>(
  target: DocumentReference<T> | CollectionReference<T> | Query<T>,
  onNextOrOptions: any,
  onErrorOrNext?: any,
  maybeOnError?: any
): Unsubscribe {
  const isOptionsFirst =
    typeof onNextOrOptions === 'object' &&
    onNextOrOptions !== null &&
    typeof onErrorOrNext === 'function';

  const onNext: (snap: any) => void = isOptionsFirst ? onErrorOrNext : onNextOrOptions;
  const onError: ((err: Error) => void) | undefined = isOptionsFirst ? maybeOnError : onErrorOrNext;

  const colPath =
    target.type === 'document'
      ? target.parent.path
      : target.type === 'query'
      ? target.collectionPath
      : target.path;

  let active = true;
  let lastSerialized = '';
  let inFlight = false;

  const runFetch = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      if (target.type === 'document') {
        const snap = await getDoc(target);
        if (!active) return;
        const sig = JSON.stringify({ exists: snap.exists(), data: snap.data() });
        if (sig !== lastSerialized) {
          lastSerialized = sig;
          onNext(snap);
        }
      } else {
        const snap = await getDocs(target);
        if (!active) return;
        const sig = JSON.stringify(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
        if (sig !== lastSerialized) {
          lastSerialized = sig;
          onNext(snap);
        }
      }
    } catch (err: any) {
      if (active && onError) {
        onError(err);
      }
    } finally {
      inFlight = false;
    }
  };

  // Initial fetch
  runFetch();

  // Instant refresh on local mutations
  let set = collectionListeners.get(colPath);
  if (!set) {
    set = new Set();
    collectionListeners.set(colPath, set);
  }
  set.add(runFetch);

  // Gentle background polling for multi-user changes while tab is visible
  const timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    runFetch();
  }, 10_000);

  return () => {
    active = false;
    clearInterval(timer);
    collectionListeners.get(colPath)?.delete(runFetch);
  };
}
