const plugin = (() => {
    // Revenge passes the plugin API object as the first argument to the
    // generated plugin wrapper. Using the wrapper argument directly avoids
    // depending on a global runtime object.
    const runtime = arguments[0];

    if (!runtime || !runtime.metro || !runtime.api || !runtime.plugin) {
        throw new Error("Revenge plugin API was not provided");
    }

    const { metro, api, plugin: pluginMeta, ui } = runtime;
    const React = metro.common?.React;
    const patcher = api.patcher;

    if (!React) {
        throw new Error("Revenge React API was not found");
    }

    if (!patcher) {
        throw new Error("Revenge patcher was not found");
    }

    const storage = pluginMeta.createStorage();

    const defaults = {
        deleteOriginalMessage: true,
        deleteDelay: 500,
        suppressNotifications: false,
        interceptAllEdits: false,
        accentColor: "#ed4245",
    };

    for (const key of Object.keys(defaults)) {
        if (storage[key] === undefined) {
            storage[key] = defaults[key];
        }
    }

    const getSetting = key =>
        storage[key] === undefined ? defaults[key] : storage[key];

    const LazyActionSheet = metro.findByProps(
        "openLazy",
        "hideActionSheet",
    );

    const MessageActions = metro.findByProps(
        "editMessage",
        "startEditMessage",
    );

    const MessageStore = metro.findByProps("getMessage");
    const UserStore = metro.findByProps("getCurrentUser");
    const Constants = metro.findByProps("Endpoints");
    const RestAPI = metro.findByProps("get", "post", "del");

    const Forms = ui?.components?.Forms || {};
    const FormRow =
        Forms.FormRow || metro.findByProps("FormRow")?.FormRow;
    const FormSwitch =
        Forms.FormSwitch || metro.findByProps("FormSwitch")?.FormSwitch;

    let pendingSilentEdit = null;
    let pendingTimer = null;

    let editPatchInstalled = false;
    let actionPatchInstalled = false;
    let actionSheetPatchInstalling = false;
    let actionSheetRenderPatched = false;

    function logError(message, error) {
        try {
            pluginMeta.logger.error(message, error);
        } catch {
            console.error("[SilentEdit]", message, error);
        }
    }

    function logInfo(message) {
        try {
            pluginMeta.logger.info(message);
        } catch {
            console.log("[SilentEdit]", message);
        }
    }

    function getCurrentUserId() {
        try {
            return UserStore?.getCurrentUser?.()?.id ?? null;
        } catch {
            return null;
        }
    }

    function getMessage(channelId, messageId) {
        try {
            return MessageStore?.getMessage?.(channelId, messageId) ?? null;
        } catch {
            return null;
        }
    }

    function getMessagesEndpoint(channelId) {
        try {
            if (typeof Constants?.Endpoints?.MESSAGES === "function") {
                return Constants.Endpoints.MESSAGES(channelId);
            }
        } catch (error) {
            logError("Failed to resolve messages endpoint", error);
        }

        return `/channels/${channelId}/messages`;
    }

    function getMessageEndpoint(channelId, messageId) {
        try {
            if (typeof Constants?.Endpoints?.MESSAGE === "function") {
                return Constants.Endpoints.MESSAGE(channelId, messageId);
            }
        } catch (error) {
            logError("Failed to resolve message endpoint", error);
        }

        return `/channels/${channelId}/messages/${messageId}`;
    }

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    async function sendMessage(
        content,
        nonce,
        channelId,
        suppressNotifications,
        messageReference,
    ) {
        if (typeof RestAPI?.post !== "function") {
            throw new Error("Discord REST POST API was not found");
        }

        const body = {
            content,
            flags: suppressNotifications ? 4096 : 0,
            mobile_network_type: "unknown",
            nonce,
            tts: false,
        };

        if (messageReference) {
            body.message_reference = {
                channel_id: messageReference.channel_id,
                message_id: messageReference.message_id,
                guild_id: messageReference.guild_id,
            };
        }

        return RestAPI.post({
            url: getMessagesEndpoint(channelId),
            body,
        });
    }

    async function deleteMessage(channelId, messageId) {
        if (typeof RestAPI?.del !== "function") {
            throw new Error("Discord REST DELETE API was not found");
        }

        return RestAPI.del({
            url: getMessageEndpoint(channelId, messageId),
        });
    }

    async function silentEditMessage(
        channelId,
        messageId,
        content,
        messageReference,
    ) {
        if (typeof content !== "string" || content.length === 0) {
            return false;
        }

        let replacementSent = false;

        try {
            await sendMessage(
                content,
                messageId,
                channelId,
                Boolean(getSetting("suppressNotifications")),
                messageReference,
            );

            replacementSent = true;

            const delay = Math.max(
                0,
                Number(getSetting("deleteDelay")) || 0,
            );

            if (delay > 0) {
                await sleep(delay);
            }

            if (getSetting("deleteOriginalMessage")) {
                await deleteMessage(channelId, messageId);
            }

            return true;
        } catch (error) {
            logError("Silent edit failed", error);
            return replacementSent;
        }
    }

    function clearPendingEdit() {
        pendingSilentEdit = null;

        if (pendingTimer !== null) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
    }

    function setPendingEdit(channelId, messageId) {
        clearPendingEdit();

        pendingSilentEdit = {
            channelId,
            messageId,
        };

        pendingTimer = setTimeout(() => {
            pendingSilentEdit = null;
            pendingTimer = null;
        }, 60_000);
    }

    function extractEditContent(args) {
        const candidate = args?.[2];

        if (typeof candidate === "string") {
            return candidate;
        }

        if (candidate && typeof candidate.content === "string") {
            return candidate.content;
        }

        return null;
    }

    function installEditPatch() {
        if (
            editPatchInstalled ||
            typeof MessageActions?.editMessage !== "function" ||
            typeof patcher.instead !== "function"
        ) {
            return;
        }

        patcher.instead(
            "editMessage",
            MessageActions,
            function (args, original) {
                try {
                    const channelId = args?.[0];
                    const messageId = args?.[1];
                    const content = extractEditContent(args);

                    if (!channelId || !messageId || content === null) {
                        return original.apply(this, args);
                    }

                    const pending = pendingSilentEdit;

                    if (
                        pending &&
                        pending.channelId === channelId &&
                        pending.messageId === messageId
                    ) {
                        clearPendingEdit();

                        const message = getMessage(channelId, messageId);

                        return silentEditMessage(
                            channelId,
                            messageId,
                            content,
                            message?.messageReference,
                        );
                    }

                    if (getSetting("interceptAllEdits")) {
                        const message = getMessage(channelId, messageId);
                        const currentUserId = getCurrentUserId();

                        if (
                            message &&
                            currentUserId &&
                            message.author?.id === currentUserId &&
                            content.length > 0
                        ) {
                            return silentEditMessage(
                                channelId,
                                messageId,
                                content,
                                message.messageReference,
                            );
                        }
                    }
                } catch (error) {
                    logError("Edit interception failed", error);
                }

                return original.apply(this, args);
            },
        );

        editPatchInstalled = true;
    }

    function isReactElement(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            "type" in value &&
            "props" in value
        );
    }

    function getTextPropNames(props) {
        if (!props || typeof props !== "object") {
            return [];
        }

        return [
            "label",
            "title",
            "text",
            "accessibilityLabel",
        ].filter(key => typeof props[key] === "string");
    }

    function isEditActionElement(element) {
        if (!isReactElement(element)) {
            return false;
        }

        const props = element.props || {};
        const hasPressHandler =
            typeof props.onPress === "function" ||
            typeof props.onClick === "function";

        if (!hasPressHandler) {
            return false;
        }

        const labels = getTextPropNames(props).map(key =>
            props[key].trim().toLowerCase(),
        );

        if (
            labels.some(label =>
                /(^|\b)edit(\b|$)/.test(label),
            )
        ) {
            return true;
        }

        const typeName = String(
            element.type?.displayName ||
            element.type?.name ||
            "",
        ).toLowerCase();

        return typeName.includes("edit");
    }

    function findActionArray(root, seen = new Set()) {
        if (root === null || root === undefined) {
            return null;
        }

        if (typeof root !== "object") {
            return null;
        }

        if (seen.has(root)) {
            return null;
        }

        seen.add(root);

        if (Array.isArray(root)) {
            if (root.some(isEditActionElement)) {
                return root;
            }

            for (const child of root) {
                const found = findActionArray(child, seen);
                if (found) {
                    return found;
                }
            }

            return null;
        }

        if (isReactElement(root) && root.props) {
            const found = findActionArray(root.props, seen);
            if (found) {
                return found;
            }
        }

        if (root.props && root.props !== root) {
            const found = findActionArray(root.props, seen);
            if (found) {
                return found;
            }
        }

        if (root.children && root.children !== root) {
            const found = findActionArray(root.children, seen);
            if (found) {
                return found;
            }
        }

        if (root.child && root.child !== root) {
            const found = findActionArray(root.child, seen);
            if (found) {
                return found;
            }
        }

        if (root.sibling && root.sibling !== root) {
            const found = findActionArray(root.sibling, seen);
            if (found) {
                return found;
            }
        }

        return null;
    }

    function hasSilentEdit(array) {
        return array.some(element => {
            if (!isReactElement(element)) {
                return false;
            }

            if (element.props?.__silentEdit === true) {
                return true;
            }

            const labels = getTextPropNames(element.props).map(key =>
                String(element.props[key]).trim().toLowerCase(),
            );

            return labels.includes("silent edit");
        });
    }

    function cloneEditAction(editElement, message) {
        const originalProps = editElement.props || {};

        const onSilentPress = () => {
            setPendingEdit(message.channel_id, message.id);

            try {
                if (typeof LazyActionSheet?.hideActionSheet === "function") {
                    LazyActionSheet.hideActionSheet();
                }

                if (
                    typeof MessageActions?.startEditMessage !== "function"
                ) {
                    throw new Error("startEditMessage was not found");
                }

                MessageActions.startEditMessage(
                    message.channel_id,
                    message.id,
                    message.content,
                );
            } catch (error) {
                clearPendingEdit();
                logError("Failed to open Discord edit UI", error);
            }
        };

        const nextProps = {
            ...originalProps,
            disabled: false,
            isDisabled: false,
            __silentEdit: true,
        };

        for (const key of getTextPropNames(originalProps)) {
            nextProps[key] = "Silent Edit";
        }

        if (typeof originalProps.children === "string") {
            nextProps.children = "Silent Edit";
        }

        if (typeof originalProps.onPress === "function") {
            nextProps.onPress = onSilentPress;
        }

        if (typeof originalProps.onClick === "function") {
            nextProps.onClick = onSilentPress;
        }

        if (originalProps.key !== undefined) {
            nextProps.key = "silent-edit";
        }

        return React.cloneElement(editElement, nextProps);
    }

    function injectSilentEdit(tree, message) {
        const actionArray = findActionArray(tree);

        if (!actionArray || hasSilentEdit(actionArray)) {
            return false;
        }

        const editIndex = actionArray.findIndex(isEditActionElement);

        if (editIndex < 0) {
            return false;
        }

        const editElement = actionArray[editIndex];
        const silentElement = cloneEditAction(editElement, message);

        actionArray.splice(editIndex + 1, 0, silentElement);
        return true;
    }

    function extractActionSheetMessage(args) {
        const props = args?.[0];

        if (!props || typeof props !== "object") {
            return null;
        }

        return (
            props.message ||
            props?.props?.message ||
            props?.route?.params?.message ||
            null
        );
    }

    function installActionPatch() {
        if (
            actionPatchInstalled ||
            typeof LazyActionSheet?.openLazy !== "function" ||
            typeof patcher.before !== "function"
        ) {
            return;
        }

        patcher.before(
            "openLazy",
            LazyActionSheet,
            args => {
                try {
                    const component = args?.[0];
                    const key = args?.[1];

                    if (key !== "MessageLongPressActionSheet") {
                        return;
                    }

                    if (!component) {
                        return;
                    }

                    if (
                        actionSheetRenderPatched ||
                        actionSheetPatchInstalling
                    ) {
                        return;
                    }

                    actionSheetPatchInstalling = true;

                    Promise.resolve(component)
                        .then(instance => {
                            if (
                                !instance?.default ||
                                typeof patcher.after !== "function"
                            ) {
                                return;
                            }

                            patcher.after(
                                "default",
                                instance,
                                (renderArgs, tree) => {
                                    try {
                                        const message =
                                            extractActionSheetMessage(
                                                renderArgs,
                                            );

                                        if (!message) {
                                            return tree;
                                        }

                                        const currentUserId =
                                            getCurrentUserId();

                                        if (
                                            !currentUserId ||
                                            message.author?.id !==
                                                currentUserId
                                        ) {
                                            return tree;
                                        }

                                        injectSilentEdit(
                                            tree,
                                            message,
                                        );
                                    } catch (error) {
                                        logError(
                                            "Failed to inject Silent Edit",
                                            error,
                                        );
                                    }

                                    return tree;
                                },
                            );

                            actionSheetRenderPatched = true;
                        })
                        .catch(error =>
                            logError(
                                "Failed to resolve message action sheet",
                                error,
                            ),
                        )
                        .finally(() => {
                            actionSheetPatchInstalling = false;
                        });
                } catch (error) {
                    actionSheetPatchInstalling = false;
                    logError(
                        "Message action-sheet interception failed",
                        error,
                    );
                }
            },
        );

        actionPatchInstalled = true;
    }

    function settingRow(title, description, value, onToggle) {
        if (FormSwitch) {
            return React.createElement(FormSwitch, {
                title,
                description,
                value: Boolean(value),
                onValueChange: onToggle,
            });
        }

        if (FormRow) {
            return React.createElement(FormRow, {
                label: `${title}: ${value ? "On" : "Off"}`,
                subLabel: description,
                onPress: () => onToggle(!value),
            });
        }

        return null;
    }

    function SettingsComponent() {
        const [, forceUpdate] = React.useReducer(
            value => value + 1,
            0,
        );

        const toggle = key => value => {
            storage[key] = value;
            forceUpdate();
        };

        const children = [
            settingRow(
                "Delete original message",
                "Delete the original server-side message after the silent replacement.",
                getSetting("deleteOriginalMessage"),
                toggle("deleteOriginalMessage"),
            ),
            settingRow(
                "Suppress notifications",
                "Adds the silent notification flag to the replacement message.",
                getSetting("suppressNotifications"),
                toggle("suppressNotifications"),
            ),
            settingRow(
                "Intercept all edits",
                "Silently intercept normal edits too, including Up Arrow editing.",
                getSetting("interceptAllEdits"),
                toggle("interceptAllEdits"),
            ),
        ].filter(Boolean);

        if (FormRow) {
            const delays = [0, 250, 500, 1000, 2000];
            const currentDelay =
                Number(getSetting("deleteDelay")) || 0;
            const currentIndex = delays.indexOf(currentDelay);
            const index = currentIndex < 0 ? 0 : currentIndex;
            const nextDelay =
                delays[(index + 1) % delays.length];

            children.push(
                React.createElement(FormRow, {
                    label: `Delete delay: ${currentDelay} ms`,
                    subLabel: `Tap to cycle: ${delays.join(", ")} ms.`,
                    onPress: () => {
                        storage.deleteDelay = nextDelay;
                        forceUpdate();
                    },
                }),
            );

            const colors = [
                "#ed4245",
                "#5865f2",
                "#57f287",
                "#fee75c",
                "#eb459e",
                "#ffffff",
            ];

            const currentColor = getSetting("accentColor");
            const colorIndex = Math.max(
                0,
                colors.indexOf(currentColor),
            );
            const nextColor =
                colors[(colorIndex + 1) % colors.length];

            children.push(
                React.createElement(FormRow, {
                    label: `Accent color: ${currentColor}`,
                    subLabel: "Tap to cycle presets.",
                    onPress: () => {
                        storage.accentColor = nextColor;
                        forceUpdate();
                    },
                }),
            );
        }

        return React.createElement(
            React.Fragment,
            null,
            ...children,
        );
    }

    return {
        start() {
            if (!MessageActions) {
                throw new Error(
                    "Discord message action module was not found",
                );
            }

            if (!MessageStore) {
                throw new Error(
                    "Discord message store was not found",
                );
            }

            if (!UserStore) {
                throw new Error(
                    "Discord user store was not found",
                );
            }

            if (!RestAPI) {
                throw new Error(
                    "Discord REST API module was not found",
                );
            }

            installEditPatch();
            installActionPatch();

            logInfo("SilentEdit loaded");
        },

        stop() {
            clearPendingEdit();

            editPatchInstalled = false;
            actionPatchInstalled = false;
            actionSheetPatchInstalling = false;
            actionSheetRenderPatched = false;

            logInfo("SilentEdit unloaded");
        },

        SettingsComponent,
    };
})();
