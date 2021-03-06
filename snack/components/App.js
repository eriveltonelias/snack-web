/* @flow */

import * as React from 'react';
import { connect } from 'react-redux';
import { create, persist } from 'web-worker-proxy';
import nullthrows from 'nullthrows';
import JSON5 from 'json5';
import mapValues from 'lodash/mapValues';
import Raven from 'raven-js';
import debounce from 'lodash/debounce';

import SnackSessionWorker from '../workers/snack-session.worker';
import Segment from '../utils/Segment';
import withAuth, { type AuthProps } from '../auth/withAuth';
import AuthManager from '../auth/authManager';

import LazyLoad from './shared/LazyLoad';
import AppShell from './Shell/AppShell';
import EmbeddedShell from './Shell/EmbeddedShell';
import AppDetails from './AppDetails';
import constants from '../configs/constants';
import { versions, DEFAULT_SDK_VERSION, FALLBACK_SDK_VERSION } from '../configs/sdk';
import { snackToEntryArray, entryArrayToSnack } from '../utils/convertFileStructure';
import { isNotMobile } from '../utils/detectPlatform';
import { isPackageJson } from '../utils/fileUtilities';
import { getSnackName } from '../utils/projectNames';
import updateEntry from '../actions/updateEntry';
import FeatureFlags from '../utils/FeatureFlags';

import type { SDKVersion } from '../configs/sdk';
import type {
  FileSystemEntry,
  TextFileEntry,
  AssetFileEntry,
  ExpoSnackFiles,
  Snack,
  QueryParams,
} from '../types';

const Auth = new AuthManager();

const DEVICE_ID_KEY = '__SNACK_DEVICE_ID';

const INITIAL_CODE = {
  'App.js': {
    contents: `import * as React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Constants } from 'expo';

// You can import from local files
import AssetExample from './components/AssetExample';

// or any pure javascript modules available in npm
import { Card } from 'react-native-elements'; // 0.19.1

export default class App extends React.Component {
  render() {
    return (
      <View style={styles.container}>
        <Text style={styles.paragraph}>
          Change code in the editor and watch it change on your phone! Save to get a shareable url.
        </Text>
        <Card title="Local Modules">
          <AssetExample />
        </Card>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Constants.statusBarHeight,
    backgroundColor: '#ecf0f1',
  },
  paragraph: {
    margin: 24,
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
    color: '#34495e',
  },
});
`,
    type: 'CODE',
  },
  'assets/expo.symbol.white.png': {
    contents:
      'https://snack-code-uploads.s3-us-west-1.amazonaws.com/~asset/bf93196f5649c822ee2eb830cfdfb636',
    type: 'ASSET',
  },
  'components/AssetExample.js': {
    contents: `import * as React from 'react';
import { Text, View, StyleSheet, Image } from 'react-native';

export default class AssetExample extends React.Component {
  render() {
    return (
      <View style={styles.container}>
        <Text style={styles.paragraph}>
          Local files and assets can be imported by dragging and dropping them into the editor
        </Text>
        <Image style={styles.logo} source={require("../assets/expo.symbol.white.png")}/>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  paragraph: {
    margin: 24,
    marginTop: 0,
    fontSize: 14,
    fontWeight: 'bold',
    textAlign: 'center',
    color: '#34495e',
  },
  logo: {
    backgroundColor: "#056ecf",
    height: 128,
    width: 128,
  }
});
`,
    type: 'CODE',
  },
};

const INITIAL_DEPENDENCIES = {
  'react-native-elements': { version: '0.19.1', isUserSpecified: true },
};

type Device = { name: string, id: string, platform: string };

type DeviceError = {|
  loc?: [number, number],
  line?: number,
  column?: number,
  message: string,
|};

type DeviceLog = {|
  device: Device,
  method: 'log' | 'error' | 'warn',
  payload: Array<any>,
|};

type Params = {
  id?: string,
  platform?: 'android' | 'ios',
  sdkVersion?: SDKVersion,
  username?: string,
  projectName?: string,
};

type Props = AuthProps & {|
  snack?: Snack,
  history: {
    push: (props: { pathname: string, search: string }) => mixed,
  },
  match: {
    params: Params,
  },
  location: Object,
  query: QueryParams,
  isEmbedded?: boolean,
|};

type SnackSessionState = {
  name: string,
  description: ?string,
  files: {},
  dependencies: {},
  sdkVersion: SDKVersion,
  isSaved: boolean,
  isResolving: boolean,
  loadingMessage: ?string,
};

type State = {|
  snackSessionState: SnackSessionState,
  snackSessionReady: boolean,
  channel: string,
  deviceId: string,
  params: Params,
  fileEntries: Array<FileSystemEntry>,
  connectedDevices: Array<Device>,
  deviceError: ?DeviceError,
  deviceLogs: Array<DeviceLog>,
  isPreview: boolean,
  wasUpgraded: boolean,
|};

type SnackSessionProxy = {
  create: (options: Object) => Promise<void>,
  session: {
    // Properties
    expoApiUrl: string,
    snackagerUrl: string,
    snackagerCloudfrontUrl: string,
    host: string,

    // Methods
    startAsync: () => Promise<void>,
    saveAsync: () => Promise<{ id: string }>,
    uploadAssetAsync: (asset: File) => Promise<string>,
    syncDependenciesAsync: (modules: { [name: string]: ?string }, callback: *) => Promise<void>,
    sendCodeAsync: (payload: ExpoSnackFiles) => Promise<void>,
    setSdkVersion: (version: SDKVersion) => Promise<void>,
    setUser: (user: { sessionSecret: ?string }) => Promise<void>,
    setName: (name: string) => Promise<void>,
    setDescription: (description: string) => Promise<void>,
    setDeviceId: (id: string) => Promise<void>,
    getState: () => Promise<SnackSessionState>,
    getChannel: () => Promise<string>,
  },

  // Event listeners
  addStateListener: (listener: *) => Promise<void>,
  addPresenceListener: (listener: *) => Promise<void>,
  addErrorListener: (listener: *) => Promise<void>,
  addLogListener: (listener: *) => Promise<void>,
  setDependencyErrorListener: (listener: *) => Promise<void>,
};

class App extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);

    const usingDefaultCode = !(
      (props.snack && props.snack.code) ||
      (props.query && props.query.code)
    );

    let code = props.snack && props.snack.code ? props.snack.code : INITIAL_CODE;

    let name = getSnackName();
    let description = undefined;
    // TODO(satya164): is this correct? we don't match for sdkVersion in the router
    let sdkVersion = props.match.params.sdkVersion || DEFAULT_SDK_VERSION;
    let dependencies = usingDefaultCode ? INITIAL_DEPENDENCIES : {};

    if (props.snack && props.snack.dependencies) {
      dependencies = props.snack.dependencies;
    }

    if (props.snack && props.snack.manifest) {
      const { manifest } = props.snack;
      name = manifest.name;
      description = manifest.description;
      sdkVersion = manifest.sdkVersion || sdkVersion;
    }

    if (props.query) {
      name = props.query.name || name;
      description = props.query.description || description;
      sdkVersion = props.query.sdkVersion || sdkVersion;
      code = props.query.code || code;
    }

    let wasUpgraded = false;

    if (!versions.hasOwnProperty(sdkVersion)) {
      Segment.getInstance().logEvent('LOADED_UNSUPPORTED_VERSION', {
        requestedVersion: sdkVersion,
        snackId: this.props.match.params.id,
      });
      sdkVersion = FALLBACK_SDK_VERSION;
      wasUpgraded = true;
    }

    if (typeof code === 'string') {
      // Code is from SDK version below 21.0.0 without multiple files support
      // Or came from embed parameters which is a string
      // Upgrade code to new format with multiple entries
      code = {
        'App.js': { contents: code, type: 'CODE' },
      };
    }

    const isMobile = !isNotMobile();
    const isPreview = !!(
      isMobile &&
      (props.match.params.id || props.match.params.projectName) &&
      !props.isEmbedded
    );

    const fileEntries = snackToEntryArray(code);

    const params = {
      platform: props.query.platform,
      sdkVersion: props.query.sdkVersion,
      ...(!props.match.params.id && props.match.params.username && props.match.params.projectName
        ? { id: `@${props.match.params.username}/${props.match.params.projectName}` }
        : null),
    };

    // Create an initial snack session state from the data we have
    // After the worker is created, it'll be replaced with uptodate data
    const snackSessionState = {
      name,
      description,
      files: code,
      dependencies,
      sdkVersion,
      isSaved: false,
      isResolving: false,
      loadingMessage: undefined,
    };

    this.state = {
      snackSessionState,
      snackSessionReady: false,
      fileEntries: FeatureFlags.isAvailable('PROJECT_DEPENDENCIES', sdkVersion)
        ? [...fileEntries, this._getPackageJson(snackSessionState)]
        : fileEntries,
      connectedDevices: [],
      deviceLogs: [],
      deviceError: null,
      channel: '',
      deviceId: '',
      isPreview,
      params,
      wasUpgraded,
    };
  }

  componentDidMount() {
    if (window.location.host.includes('expo.io')) {
      Raven.config('https://6501f7d527764d85b045b0ce31927c75@sentry.io/191351').install();
      const build_date = new Date(process.env.BUILD_TIMESTAMP || 0).toUTCString();
      Raven.setTagsContext({ build_date });
      Segment.getInstance().identify({ build_date });
    }

    /* $FlowFixMe */
    this._snackSessionWorker = new SnackSessionWorker();
    this._snack = create(this._snackSessionWorker);

    this._initializeSnackSession();
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    if (this.state.fileEntries === prevState.fileEntries) {
      return;
    }

    let shouldUpdateSnackSession = false;

    if (this.state.fileEntries.length !== prevState.fileEntries.length) {
      shouldUpdateSnackSession = true;
    } else {
      const items = prevState.fileEntries.reduce((acc, { item }) => {
        acc[item.path] = item;
        return acc;
      }, {});

      shouldUpdateSnackSession = this.state.fileEntries.some(
        ({ item }) => !item.virtual && items[item.path] !== item
      );
    }

    if (shouldUpdateSnackSession) {
      this._sendCode();
    }
  }

  componentWillUnmount() {
    this._snackSessionWorker && this._snackSessionWorker.terminate();
    this._snackSessionDependencyErrorListener &&
      this._snackSessionDependencyErrorListener.dispose();
    this._snackSessionLogListener && this._snackSessionLogListener.dispose();
    this._snackSessionErrorListener && this._snackSessionErrorListener.dispose();
    this._snackSessionPresenceListener && this._snackSessionPresenceListener.dispose();
    this._snackSessionStateListener && this._snackSessionStateListener.dispose();
  }

  _initializeSnackSession = async () => {
    const { snackSessionState, params, wasUpgraded } = this.state;

    let deviceId;

    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        deviceId = localStorage.getItem(DEVICE_ID_KEY);
      }

      if (deviceId) {
        this.setState({ deviceId });
      }
    } catch (e) {
      // Ignore error
    }

    await this._snack.create({
      verbose: false,
      snackId: !wasUpgraded ? params.id : null,
      files: snackSessionState.files,
      name: snackSessionState.name,
      description: snackSessionState.description,
      sdkVersion: snackSessionState.sdkVersion,
      dependencies: snackSessionState.dependencies,
      user: { idToken: Auth.currentIdToken, sessionSecret: Auth.currentSessionSecret },
      deviceId,
    });

    this._snack.session.expoApiUrl = nullthrows(process.env.API_SERVER_URL);

    const isLocal = window.location.host.includes('expo.test');
    const isStaging = window.location.host.includes('staging');

    if (isStaging) {
      this._snack.session.host = 'staging.expo.io';
    } else if (isLocal) {
      this._snack.session.host = constants.ngrok;
    }

    if (this.props.query.local_snackager === 'true') {
      this._snack.session.snackagerUrl = 'http://localhost:3001';
      this._snack.session.snackagerCloudfrontUrl = 'https://ductmb1crhe2d.cloudfront.net';
    } else if (isStaging) {
      this._snack.session.snackagerUrl = 'https://staging.snackager.expo.io';
      this._snack.session.snackagerCloudfrontUrl = 'https://ductmb1crhe2d.cloudfront.net';
    }

    const sessionSecret = this.props.getSessionSecret();

    if (sessionSecret) {
      await this._snack.session.setUser({ sessionSecret });
    }

    // Add the listeners
    this._snackSessionDependencyErrorListener = persist(this._handleSnackDependencyError);
    this._snackSessionLogListener = persist(this._handleSnackSessionLog);
    this._snackSessionErrorListener = persist(this._handleSnackSessionError);
    this._snackSessionPresenceListener = persist(this._handleSnackSessionPresence);
    this._snackSessionStateListener = persist(this._handleSnackSessionState);

    this._snack.setDependencyErrorListener(this._snackSessionDependencyErrorListener);
    this._snack.addLogListener(this._snackSessionLogListener);
    this._snack.addErrorListener(this._snackSessionErrorListener);
    this._snack.addPresenceListener(this._snackSessionPresenceListener);
    this._snack.addStateListener(this._snackSessionStateListener);

    await this._snack.session.startAsync();

    const channel = await this._snack.session.getChannel();
    const sessionState = await this._snack.session.getState();

    this.setState({
      channel,
      snackSessionState: sessionState,
      snackSessionReady: true,
    });

    Segment.getInstance().setCommonData({
      snackId: this.state.params.id,
      isEmbedded: this.props.isEmbedded || false,
    });
    Segment.getInstance().logEvent('LOADED_SNACK', {
      sdkVersion: this.state.snackSessionState.sdkVersion,
    });
  };

  _snack: SnackSessionProxy;
  _snackSessionWorker: Worker;
  _snackSessionDependencyErrorListener: *;
  _snackSessionLogListener: *;
  _snackSessionErrorListener: *;
  _snackSessionPresenceListener: *;
  _snackSessionStateListener: *;

  _handleSnackDependencyError = error => Raven.captureMessage(error);

  _handleSnackSessionLog = payload => {
    const deviceLog = {
      device: payload.device,
      method: payload.method,
      payload: payload.arguments,
    };

    this.setState(state => ({
      deviceLogs: [...state.deviceLogs.slice(-99), deviceLog],
    }));
  };

  _handleSnackSessionError = errors => {
    let deviceError: ?DeviceError = null;

    if (errors.length) {
      deviceError = {
        message: errors[0].message,
      };

      if (errors[0].startColumn && errors[0].startLine) {
        deviceError.loc = [errors[0].startLine, errors[0].startColumn];
      }

      if (errors[0].startLine) {
        deviceError.line = errors[0].startLine;
      }

      if (errors[0].startColumn) {
        deviceError.column = errors[0].startColumn;
      }
    }

    this.setState({
      deviceError,
    });
  };

  _handleSnackSessionPresence = presence => {
    if (presence.status === 'join') {
      this.setState(state => ({
        connectedDevices: [...state.connectedDevices, presence.device],
      }));
    } else if (presence.status === 'leave') {
      this.setState(state => ({
        connectedDevices: state.connectedDevices.filter(device => device.id !== presence.device.id),
      }));
    }
  };

  _handleSnackSessionState = (snackSessionState: SnackSessionState) =>
    this.setState(state => {
      let { fileEntries } = state;

      const currentFile = this._findFocusedEntry(fileEntries);

      if (
        currentFile &&
        snackSessionState.files.hasOwnProperty(currentFile.item.path) &&
        snackSessionState.files[currentFile.item.path].contents !==
          (currentFile.item.asset ? currentFile.item.uri : currentFile.item.content)
      ) {
        const contents = snackSessionState.files[currentFile.item.path].contents;

        fileEntries = fileEntries.map(entry => {
          if (entry.item.path === currentFile.item.path && entry.item.type === 'file') {
            if (entry.item.asset) {
              if (entry.item.uri !== contents) {
                return updateEntry(entry, {
                  item: { uri: contents },
                });
              }
            } else {
              if (entry.item.content !== contents) {
                return updateEntry(entry, {
                  item: { content: contents },
                });
              }
            }
          }

          return entry;
        });
      }

      // If we switched between versions with/without support for package.json, add/remove it accordingly
      if (state.snackSessionState.sdkVersion !== snackSessionState.sdkVersion) {
        const packageJson = fileEntries.find(entry => isPackageJson(entry.item.path));

        if (
          FeatureFlags.isAvailable(
            'PROJECT_DEPENDENCIES',
            ((snackSessionState.sdkVersion: any): SDKVersion)
          )
        ) {
          if (!packageJson) {
            fileEntries = [...fileEntries, this._getPackageJson(snackSessionState)];
          }
        } else {
          if (packageJson) {
            fileEntries = fileEntries.filter(entry => !isPackageJson(entry.item.path));
          }
        }
      }

      return {
        snackSessionState,
        fileEntries,
      };
    });

  _sendCodeNotDebounced = () =>
    this._snack.session.sendCodeAsync(
      // map state.fileEntries to the correct type before sending to snackSession
      /* $FlowFixMe */
      entryArrayToSnack(this.state.fileEntries.filter(e => !e.item.virtual))
    );

  _sendCode = debounce(this._sendCodeNotDebounced, 1000);

  _getPackageJson = snackSessionState => ({
    item: {
      path: 'package.json',
      type: 'file',
      content: JSON.stringify(
        {
          dependencies: mapValues(snackSessionState.dependencies, dep => dep.version),
        },
        null,
        2
      ),
      virtual: true,
    },
    state: {},
  });

  _handleChangeName = (name: string) => this._snack.session.setName(name);

  _handleChangeDescription = (description: string) =>
    this._snack.session.setDescription(description);

  _handleChangeCode = (content: string) =>
    this.setState((state: State) => ({
      fileEntries: state.fileEntries.map(entry => {
        if (entry.item.type === 'file' && entry.state.isFocused) {
          return updateEntry(entry, { item: { content } });
        }
        return entry;
      }),
      deviceError: null,
    }));

  _handleFileEntriesChange = (nextFileEntries: FileSystemEntry[]): Promise<void> => {
    return new Promise(resolve =>
      this.setState(state => {
        const previousFocusedEntry = this._findFocusedEntry(state.fileEntries);
        const nextFocusedEntry = this._findFocusedEntry(nextFileEntries);

        let fileEntries = nextFileEntries;

        if (
          // Don't update package.json if we're resolving
          !state.snackSessionState.isResolving &&
          // Update package.json when it's focused again instead of everytime deps change
          // This avoids changing it while you're still editing the file
          nextFocusedEntry &&
          isPackageJson(nextFocusedEntry.item.path) &&
          (previousFocusedEntry ? !isPackageJson(previousFocusedEntry.item.path) : true)
        ) {
          fileEntries = fileEntries.map(
            entry =>
              isPackageJson(entry.item.path)
                ? updateEntry(this._getPackageJson(state.snackSessionState), { state: entry.state })
                : entry
          );
        }

        return { fileEntries };
      }, resolve)
    );
  };

  _handleChangeSDKVersion = (sdkVersion: SDKVersion) =>
    this._snack.session.setSdkVersion(sdkVersion);

  _handleClearDeviceLogs = () =>
    this.setState({
      deviceLogs: [],
    });

  //TODO: better way of getting snack id
  _handleDownloadAsync = async () => {
    // Already check if Snack is saved in EditorView.js
    const snackId = this.state.params.id;

    // this shouldn't happen
    if (!snackId) {
      return;
    }

    /* $FlowIgnore */
    const url = `${process.env.API_SERVER_URL}/--/api/v2/snack/download/${snackId}`;

    // Simulate link click to download file
    let element = document.createElement('a');
    if (element && document.body) {
      document.body.appendChild(element);
      element.setAttribute('href', url);
      element.setAttribute('download', 'snack.zip');
      element.style.display = '';
      element.click();
      // $FlowIgnore
      document.body.removeChild(element);
    }
  };

  // TODO: (tc) Remove flowFixMe once types.js has been fixed
  _handlePublishAsync = async (options: { allowedOnProfile?: boolean }) => {
    // Send updated code first
    this._sendCodeNotDebounced();

    const cntCodeFile = this.state.fileEntries.filter(
      /* $FlowFixMe */
      entry => entry.item && entry.item.type === 'file' && !entry.item.asset
    ).length;
    const cntAssetFile = this.state.fileEntries.filter(
      /* $FlowFixMe */
      entry => entry.item.type && entry.item.type === 'file' && entry.item.asset
    ).length;
    const cntDirectory = this.state.fileEntries.filter(entry => entry.item.type === 'folder')
      .length;
    Segment.getInstance().logEvent(
      'SAVED_SNACK',
      { cntCodeFile, cntAssetFile, cntDirectory },
      'lastSave'
    );
    Segment.getInstance().startTimer('lastSave');

    if (options.allowedOnProfile) {
      await this._updateUser();
    } else {
      await this._snack.session.setUser({ sessionSecret: undefined });
    }

    const saveResult = await this._snack.session.saveAsync();

    this.props.history.push({
      pathname: `/${saveResult.id}`,
      search: this.props.location.search,
    });

    this.setState(state => ({
      params: {
        ...state.params,
        id: saveResult.id,
      },
    }));
  };

  _updateUser = async () => {
    const sessionSecret = this.props.getSessionSecret();

    if (sessionSecret) {
      await this._snack.session.setUser({ sessionSecret });
    }
  };

  _setDeviceId = (deviceId: string) => {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
      } catch (e) {
        // Do nothing
      }
    }

    this._snack.session.setDeviceId(deviceId);
  };

  _findFocusedEntry = (entries: FileSystemEntry[]): ?(TextFileEntry | AssetFileEntry) =>
    /* $FlowFixMe */
    entries.find(
      /* $FlowFixMe */
      ({ item, state }) => item.type === 'file' && state.isFocused
    );

  _handleOpenEditor = () => this.setState({ isPreview: false });

  _uploadAssetAsync = asset => this._snack.session.uploadAssetAsync(asset);

  _syncDependenciesAsync = async (dependencies, callback) => {
    const errorListener = persist(callback);

    try {
      await this._snack.session.syncDependenciesAsync(dependencies, errorListener);
    } finally {
      errorListener.dispose();
    }
  };

  render() {
    if (this.state.isPreview) {
      return (
        <AppDetails
          name={this.state.snackSessionState.name}
          description={this.state.snackSessionState.description}
          channel={this.state.channel}
          snackId={this.state.params.id}
          sdkVersion={this.state.snackSessionState.sdkVersion}
          onOpenEditor={this._handleOpenEditor}
        />
      );
    } else {
      return (
        <LazyLoad
          load={() => {
            if (this.props.isEmbedded) {
              return import('./EmbeddedEditorView');
            } else {
              return import('./EditorView');
            }
          }}>
          {({ loaded, data: Comp }) =>
            loaded && this.state.snackSessionReady ? (
              <Comp
                creatorUsername={this.state.params.username}
                fileEntries={this.state.fileEntries}
                entry={this._findFocusedEntry(this.state.fileEntries)}
                channel={this.state.channel}
                name={this.state.snackSessionState.name}
                description={this.state.snackSessionState.description}
                sdkVersion={this.state.snackSessionState.sdkVersion}
                isPublished={this.state.snackSessionState.isSaved}
                isResolving={this.state.snackSessionState.isResolving}
                loadingMessage={this.state.snackSessionState.loadingMessage}
                dependencies={this.state.snackSessionState.dependencies}
                params={this.state.params}
                onFileEntriesChange={this._handleFileEntriesChange}
                onChangeCode={this._handleChangeCode}
                onChangeName={this._handleChangeName}
                onChangeDescription={this._handleChangeDescription}
                onChangeSDKVersion={this._handleChangeSDKVersion}
                onClearDeviceLogs={this._handleClearDeviceLogs}
                onPublishAsync={this._handlePublishAsync}
                onSignIn={this._updateUser}
                onDownloadAsync={this._handleDownloadAsync}
                uploadFileAsync={this._uploadAssetAsync}
                syncDependenciesAsync={this._syncDependenciesAsync}
                setDeviceId={this._setDeviceId}
                deviceId={this.state.deviceId}
                connectedDevices={this.state.connectedDevices}
                deviceError={this.state.deviceError}
                deviceLogs={this.state.deviceLogs}
                sessionID={this.props.query.session_id}
                query={this.props.query}
                wasUpgraded={this.state.wasUpgraded}
                viewer={this.props.viewer}
              />
            ) : this.props.isEmbedded ? (
              <EmbeddedShell />
            ) : (
              <AppShell />
            )}
        </LazyLoad>
      );
    }
  }
}

export default connect(state => ({
  viewer: state.viewer,
}))(withAuth(App));
