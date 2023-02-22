import { PromptManager } from "zotero-plugin-toolkit/dist/managers/prompt";
import { BasicTool } from "zotero-plugin-toolkit/dist/basic";
import { config, name as packageName } from "../package.json";
import { AttachmentRecord, PageRecord } from "./data";
import localeString from "./locale";

/**
 * Convert milliseconds to seconds.
 * @param ms milliseconds
 * @returns seconds
 */
function ms2s(ms: number) {
  return Math.round(ms / 1000);
}

export class ReadingHistoryGlobal {
  /** @private 汇集所有插件注册的选项，只要有一个使能就要开启记录 */
  private _recordingOptions: Record<keyof RecordingOptions, number>;

  /** @private 缓存的主条目，下标为libraryID */
  private _mainItems: Array<Zotero.Item | null>;

  /** @private 缓存的历史记录，下标为ID */
  private readonly _cached: Array<RecordCache | null>;

  /** @private 当前打开的阅读器 */
  private _activeReader?: _ZoteroTypes.ReaderInstance;

  /** @readonly 插件注册的钩子函数，记录时调用 */
  readonly cachedHooks: Set<SavingHook>;

  private _toolkit: PromptManager;
  private _scanPeriod: number;
  private _readerState: {
    firstIdx: number;
    firstTop: number;
    secondIdx: number;
    secondTop: number;
    counter: number;
  };

  /**
   * @private 单例模式下不能直接使用构造函数
   * @see getInstance
   */
  private constructor() {
    this.cachedHooks = new Set();
    this._mainItems = [];
    this._cached = [];
    this._recordingOptions = {
      timestamp: 0,
      pageTotal: 0,
      groupUser: 0,
      numPages: 0,
    };
    this._readerState = {
      firstIdx: 0,
      firstTop: 0,
      secondIdx: 0,
      secondTop: 0,
      counter: 0,
    };

    // 监听条目更改事件，主要用于保护数据
    this.zotero.Notifier.registerObserver(
      {
        notify: async (
          event: _ZoteroTypes.Notifier.Event,
          type: _ZoteroTypes.Notifier.Type,
          ids: number[] | string[]
        ) => {
          const restore = (item: Zotero.DataObject) => {
              this.zotero.debug(this.locale.deletingItem);
              this.zotero.debug(item);
              // 恢复被删的条目
              item.deleted = false;
              item.saveTx({ skipDateModifiedUpdate: true, skipNotifier: true });
            },
            isMain = (item: Zotero.Item) =>
              this._mainItems[item.libraryID]?.id == item.id ||
              (item.itemType == "computerProgram" &&
                item.getField("archiveLocation") ==
                  this.zotero.URI.getLibraryURI(item.libraryID) &&
                item.getField("shortTitle") == packageName),
            isNote = async (item: Zotero.Item) =>
              item.itemType == "note" &&
              this._mainItems[item.libraryID]?.id == item.parentItemID,
            items = ids.map((id) => this.zotero.Items.get(id)), // 触发事件的条目
            mainItems = items.filter(isMain); // 筛选出的主条目

          switch (event) {
            case "trash":
              mainItems.forEach(restore); // 恢复所有被删的主条目
              for (const it of items) if (await isNote(it)) restore(it); // 恢复主条目下所有笔记
              break;

            case "modify":
              mainItems.forEach((it) => {
                // TODO: 若archiveLocation已被修改，则此处无法获取，考虑patch setField
              });
              for (const it of items)
                if (await isNote(it)) window.alert(this.locale.modifyingNote);
              break; // TODO：此处并不能阻止修改，且保存时需skipNotify

            default:
              break;
          }
        },
      },
      ["item"]
    );
    // 初始化工具箱，不产生任何输出
    this._toolkit = new PromptManager();
    this._toolkit.basicOptions.log.disableConsole = true;
    this._toolkit.basicOptions.log.disableZLog = true;

    this._toolkit.patch(
      this.zotero.Search.prototype,
      "search",
      packageName,
      (origin) =>
        // 防止阅读器侧边栏搜索到主条目下的笔记
        async function (this: Zotero.Search, asTempTable: boolean) {
          const ids: number[] = await origin.apply(this, asTempTable), // 原始搜索结果
            conditions = this.getConditions(); // 当前搜索的条件
          if (
            !asTempTable &&
            !conditions[2] &&
            conditions[0]?.condition == "libraryID" &&
            conditions[0]?.operator == "is" &&
            conditions[1]?.condition == "itemType" &&
            conditions[1]?.operator == "is" &&
            conditions[1]?.value == "note"
          ) {
            const mainItemKey = (
              await ReadingHistoryGlobal.getInstance().getMainItem(
                parseInt(conditions[0].value)
              )
            ).key; // 必须在这个if语句内，否则可能产生递归！
            // window.console.trace(ids, conditions, mainItemKey);
            return ids.filter(
              (id) => Zotero.Items.get(id).parentItemKey != mainItemKey
            );
          } else return ids;
        }
    );
    // 初始化定时器回调函数
    this.zotero
      .getMainWindow()
      .setInterval(this.schedule.bind(this), (this._scanPeriod = 1000)); // 周期暂时在这里初始化，以后改成prompt
    this.loadAll();
  }

  /**
   * 单例模式
   * @returns 全局唯一的ReadingHistoryGlobal实例
   */
  static getInstance(): ReadingHistoryGlobal {
    return (BasicTool.getZotero()[config.globalInstance] ??=
      new ReadingHistoryGlobal());
  }

  private loadAll(): void {
    const loadLib = async (libID: number) => {
      const mainItem = await this.getMainItem(libID);
      await mainItem.loadDataType("childItems"); // 等待主条目数据库加载子条目
      mainItem.getNotes().forEach(async (noteID) => {
        const noteItem = (await this.zotero.Items.getAsync(
          noteID
        )) as Zotero.Item;
        await noteItem.loadDataType("note"); // 等待笔记数据库加载
        const his = this.parseNote(noteItem);
        if (his) {
          // 缓存解析出的记录
          const id = this.zotero.Items.getIDFromLibraryAndKey(libID, his.key);
          id && (this._cached[id] = { note: noteItem, ...his });
        }
      });
    };
    loadLib(1);
    this.zotero.Groups.getAll()
      .map((group: Zotero.DataObject) =>
        this.zotero.Groups.getLibraryIDFromGroupID(group.id)
      )
      .forEach(loadLib);
  }

  private get zotero(): _ZoteroTypes.Zotero {
    return BasicTool.getZotero();
  }

  /**
   * @see _recordingOptions
   */
  get recordingOptions(): Required<RecordingOptions> {
    return {
      timestamp: this._recordingOptions.timestamp > 0,
      pageTotal: this._recordingOptions.pageTotal > 0,
      groupUser: this._recordingOptions.groupUser > 0,
      numPages: this._recordingOptions.numPages > 0,
    };
  }

  addOption(val: RecordingOptions) {
    for (const opt in val)
      if (val[opt as keyof RecordingOptions])
        ++this._recordingOptions[opt as keyof RecordingOptions];
  }
  removeOption(val: RecordingOptions) {
    for (const opt in val)
      if (
        val[opt as keyof RecordingOptions] &&
        this._recordingOptions[opt as keyof RecordingOptions] > 0
      )
        --this._recordingOptions[opt as keyof RecordingOptions];
  }

  /**
   * @private 根据当前语言环境返回对应的语言包，默认英语
   */
  private get locale(): typeof localeString["en-US"] {
    if (this.zotero.locale in localeString)
      return localeString[this.zotero.locale as keyof typeof localeString];
    else return localeString["en-US"];
  }

  /**
   * 新建与PDF相关联的笔记，存储在主条目下
   * @param attachment PDF条目
   * @returns 新建的笔记条目
   */
  private async newNoteItem(attachment: Zotero.Item): Promise<Zotero.Item> {
    const item = new this.zotero.Item("note");
    item.libraryID = attachment.libraryID;
    item.parentID = (await this.getMainItem(attachment.libraryID)).id; // 若强制删除则成为独立笔记
    item.setNote(`${packageName}#${attachment.key}\n{}`);
    item.addRelatedItem(attachment);
    // 必须等待新条目存入数据库后才能建立关联
    if ((await item.saveTx()) && attachment.addRelatedItem(item))
      attachment.saveTx({ skipDateModifiedUpdate: true });
    return item;
  }

  /**
   * 根据libraryID新建主条目，用于存储笔记条目，每个文库有且仅有一个
   * @param libraryID 主条目所在文库的ID
   * @returns 新建的主条目
   */
  private async newMainItem(libraryID: number): Promise<Zotero.Item> {
    this.zotero.debug(
      "[zotero-reading-history] Creating new main item in library " + libraryID
    );
    const item = new this.zotero.Item("computerProgram");
    item.setField("archiveLocation", this.zotero.URI.getLibraryURI(libraryID));
    item.setField("title", this.locale.mainItemTitle);
    item.setField("shortTitle", packageName);
    item.setField("programmingLanguage", "JSON");
    item.setField("abstractNote", this.locale.description);
    item.setField(
      "url",
      "https://github.com/volatile-static/zotero-plugin-toolkit"
    );
    if (this.zotero.Groups.getByLibraryID(libraryID))
      item.setField(
        "libraryCatalog",
        this.zotero.Groups.getByLibraryID(libraryID).name
      );
    item.setCreators([
      {
        fieldMode: 1,
        creatorType: "contributor",
        lastName: "MuiseDestiny",
      },
      {
        creatorType: "programmer",
        firstName: "volatile",
        lastName: "static",
      },
    ]);
    item.libraryID = libraryID;
    await item.saveTx();
    this._mainItems[libraryID] = item;
    return item;
  }

  /**
   * 搜索文库中的主条目，若不存在则新建。
   * @summary 同时满足以下三点被认为是主条目：
   * 1. shortTitle is {@link packageName}
   * 2. itemType is computerProgram
   * 3. archiveLocation is {@link Zotero.URI.getLibraryURI}
   * @param [libraryID=1] 默认为用户文库
   * @returns 已有的或新建的主条目
   */
  async getMainItem(libraryID: number = 1): Promise<Zotero.Item> {
    if (this._mainItems[libraryID]) return this._mainItems[libraryID]!;

    const searcher = new this.zotero.Search();
    searcher.addCondition("libraryID", "is", String(libraryID));
    searcher.addCondition("shortTitle", "is", packageName);
    searcher.addCondition("itemType", "is", "computerProgram");
    searcher.addCondition(
      "archiveLocation",
      "is",
      this.zotero.URI.getLibraryURI(libraryID)
    );
    const ids = await searcher.search();

    if (!ids.length) return this.newMainItem(libraryID); // 没搜到，新建
    else if (ids.length > 1) {
      // TODO: merge
      throw new Error("主条目不唯一！");
    } else
      return (this._mainItems[libraryID] = (await this.zotero.Items.getAsync(
        ids[0]
      )) as Zotero.Item);
  }

  /**
   * 解析笔记条目中的历史记录
   * @param noteItem 存储历史记录的笔记条目
   * @returns record是一个AttachmentRecord实例，key是PDF条目的key
   */
  parseNote(noteItem: Zotero.Item): HistoryAtt | null {
    const note = noteItem.note,
      [header, data] = note.split("\n"), // 第一行是标题，第二行是数据
      [sign, key] = header.split("#");

    if (sign != packageName || key?.length < 1) return null;
    let json = {};
    try {
      json = JSON.parse(data);
    } catch (error) {
      if (error instanceof SyntaxError) {
        data.replace(/<\/?\w+>/g, ""); // TODO: 考虑更复杂的情况
        json = JSON.parse(data);
      } else {
        window.console.trace(error);
        return null;
      }
    }
    return { record: new AttachmentRecord(json), key };
  }

  /**
   * 须确保{@link _activeReader}已载入
   * @param history 待记录的对象，函数有副作用
   * @returns 与参数一样
   */
  private record(history: AttachmentRecord) {
    const recordPage = (idx: number) => {
        const pageHis = (history.pages[idx] ??= new PageRecord());

        if (this.recordingOptions.numPages)
          history.numPages ??= (
            this._activeReader!._iframeWindow as any
          ).wrappedJSObject.PDFViewerApplication.pdfDocument.numPages;

        if (this.recordingOptions.pageTotal)
          pageHis.totalSeconds =
            (pageHis.totalSeconds ?? 0) + ms2s(this._scanPeriod);

        if (this.recordingOptions.timestamp) {
          pageHis.period ??= {};
          pageHis.period[ms2s(new Date().getTime())] = ms2s(this._scanPeriod);
        }

        if (this.recordingOptions.groupUser) {
          const item = this.zotero.Items.getLibraryAndKeyFromID(
            this._activeReader!.itemID!
          );
          // 只有群组才记录不同用户
          if (item && item.libraryID > 1) {
            pageHis.userSeconds ??= {};
            const userID = this.zotero.Users.getCurrentUserID();
            pageHis.userSeconds[userID] =
              (pageHis.userSeconds[userID] ?? 0) + ms2s(this._scanPeriod);
          }
        }
      },
      firstState = this._activeReader!.state,
      firstPage = firstState?.pageIndex,
      secondState = this._activeReader!.getSecondViewState(),
      secondPage = secondState?.pageIndex;

    if (
      this._readerState.firstIdx == firstPage &&
      this._readerState.secondIdx == secondPage &&
      this._readerState.firstTop == firstState?.top &&
      this._readerState.secondTop == secondState?.top
    ) {
      if (this._readerState.counter > 20) return;  // TODO: 用户自定义
      else ++this._readerState.counter;
    }
    this._readerState = {
      firstIdx: firstPage,
      secondIdx: secondPage ?? 0,
      firstTop: firstState?.top,
      secondTop: secondState?.top ?? 0,
      counter: 0,
    };

    firstPage && recordPage(firstPage);
    if (secondPage && secondPage != firstPage) recordPage(secondPage);
  }

  /**
   * @private 将记录存入笔记
   */
  private saveNote(cache: RecordCache) {
    cache.note.setNote(
      `${packageName}#${cache.key}\n${JSON.stringify(cache.record)}`
    );
    cache.note.saveTx({ skipSelect: true, skipNotifier: true });
  }

  private async getCache(attID: number) {
    if (!this._cached[attID]) {
      const attachment = this.zotero.Items.get(attID);
      this._cached[attID] = {
        note: await this.newNoteItem(attachment),
        key: attachment.key,
        record: new AttachmentRecord(),
      };
    }
    return this._cached[attID] as RecordCache;
  }

  /**
   * The callback of timer triggered periodically.
   */
  private async schedule() {
    if (
      Object.values(this._recordingOptions).reduce((sum, opt) => sum + opt) < 1
    )
      return; // 未注册，不执行
    this._activeReader = this.zotero.Reader._readers.find((r) =>
      r._iframeWindow?.document.hasFocus()
    ); // refresh activated reader

    if (this._activeReader?.itemID) {
      const cache = await this.getCache(this._activeReader.itemID); // 当前PDF的缓存
      this.record(cache.record); // 先记录到缓存

      this.cachedHooks.forEach((hook) =>
        cache.record.mergeJSON(hook(this._activeReader!))
      );

      this.saveNote(cache); // 保存本次记录
    }
  }

  public get cached(): Array<Readonly<RecordCache> | null> {
    return this._cached;
  }

  getCachedMainItem(libraryID: number) {
    return this._mainItems[libraryID];
  }

  clearHistory(libraryID: number = 1) {
    for (const id in this._cached) {
      const note = this._cached[id]?.note;
      if (note && this._mainItems[libraryID]?.getNotes().includes(note.id)) {
        note.deleted = true;
        note.saveTx({ skipNotifier: true });
        delete this._cached[id];
      }
    }
  }
}

/**
 * The function that returns data to be saved in note during {@link ReadingHistory.schedule}.
 */
export type SavingHook = (reader: _ZoteroTypes.ReaderInstance) => object;

/**
 * Specifying which data will be recorded during {@link Recorder.schedule}.
 * @property {boolean} [timestamp] Record full history with timestamp.
 * @property {boolean} [pageTotal] Record the total time of a page to `p: { 1: { T } }`.
 * @property {boolean} [groupUser]
 */
export interface RecordingOptions {
  timestamp?: boolean;
  pageTotal?: boolean;
  groupUser?: boolean;
  numPages?: boolean;
}

interface HistoryAtt {
  key: string;
  record: AttachmentRecord;
}

export interface RecordCache extends HistoryAtt {
  note: Zotero.Item;
}
