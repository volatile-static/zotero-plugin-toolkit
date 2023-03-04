import { BasicTool } from "zotero-plugin-toolkit/dist/basic";
import { config } from "../package.json";

export default class {
  private toolkit: BasicTool;
  constructor(toolkit: BasicTool) {
    this.toolkit = toolkit;
  }
  get(key: PreferenceKey) {
    return this.toolkit
      .getGlobal("Zotero")
      .Prefs.get(config.preferenceKey + "." + key);
  }
  set(key: PreferenceKey, value: boolean | string | number) {
    return this.toolkit
      .getGlobal("Zotero")
      .Prefs.set(config.preferenceKey + "." + key, value);
  }
}

type PreferenceKey =
  | "disabledLibraries"
  | "saveInLocaleFile"
  | "periodForRecording"
  | "modificationProtect"
  | "recordGroupUserName";
