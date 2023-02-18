import {
  ReadingHistoryGlobal,
  RecordingOptions,
  SavingHook,
  RecordCache,
} from "./singleton";
import { BasicTool } from "zotero-plugin-toolkit/dist/basic";

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

  /**
   *  @file chrome\content\zotero\xpcom\data\item.js
   *  @see Zotero.Item.getBestAttachments
   */
  async getInTopLevel(item: Zotero.Item) {
    if (!item.isRegularItem()) return [];
    await item.loadDataType("itemData");
    const zotero = BasicTool.getZotero(),
      url = item.getField("url"),
      urlFieldID = zotero.ItemFields.getID("url"),
      sql =
        "SELECT IA.itemID FROM itemAttachments IA NATURAL JOIN items I " +
        `LEFT JOIN itemData ID ON (IA.itemID=ID.itemID AND fieldID=${urlFieldID}) ` +
        "LEFT JOIN itemDataValues IDV ON (ID.valueID=IDV.valueID) " +
        `WHERE parentItemID=? AND linkMode NOT IN (${zotero.Attachments.LINK_MODE_LINKED_URL}) ` +
        "AND IA.itemID NOT IN (SELECT itemID FROM deletedItems) " +
        "ORDER BY contentType='application/pdf' DESC, value=? DESC, dateAdded ASC",
      itemIDs: number[] = await Zotero.DB.columnQueryAsync(sql, [item.id, url]);
    return itemIDs
      .map((id) => this.getByAttachment(id))
      .filter((his) => his) as AttachmentHistory[];
  }

  getInTopLevelSync(item: Zotero.Item) {
    return item
      .getAttachments()
      .map((id) => this.getByAttachment(id))
      .filter((his) => his) as AttachmentHistory[];
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
