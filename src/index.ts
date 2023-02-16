import {
  ReadingHistoryGlobal,
  RecordingOptions,
  SavingHook,
  RecordCache,
} from "./singleton";

export type AttachmentHistory = Readonly<RecordCache>;

export default class ReadingHistory {
  protected readonly recorder: ReadingHistoryGlobal;
  private readonly options: RecordingOptions;
  private readonly hook?: SavingHook;
  readonly clearAll;

  constructor(options: RecordingOptions = {}, hook?: SavingHook) {
    this.recorder = ReadingHistoryGlobal.getInstance();
    this.recorder.addOption((this.options = options));
    this.clearAll = this.recorder.clearHistory;
    this.hook = hook;
    hook && this.recorder.cachedHooks.add(hook);
  }

  disable() {
    this.recorder.removeOption(this.options);
    this.hook && this.recorder.cachedHooks.delete(this.hook);
  }

  getByAttachment(att: Zotero.Item | number): AttachmentHistory | null {
    return this.recorder.cached[typeof att == "number" ? att : att.id];
  }

  async getInTopLevel(item: Zotero.Item) {
    const result = [];
    for (const att of await item.getBestAttachments()) {
      const cache = this.recorder.cached[att.id];
      cache && result.push(cache);
    }
    return result;
  }

  getInCollection(collection: Zotero.Collection) {
    return collection
      .getChildItems()
      .filter((it) => it.isRegularItem())
      .map((it) => this.getInTopLevel(it));
  }

  getInLibrary(libraryID: number = 1) {
    return this.recorder.cached.filter(
      (c) => c?.note.libraryID == libraryID
    ) as AttachmentHistory[];
  }

  getAll() {
    return this.recorder.cached;
  }
}
