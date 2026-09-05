const plugin = (() => {
    const runtime = arguments[0];

    const { metro, api, plugin: pluginMeta, ui } = runtime;
    const { React } = metro.common;

    const patcher = api.patcher;
    const storage = pluginMeta.createStorage();

    const defaults = {
        deleteOriginalMessage: true,
        deleteDelay: 500,
        suppressNotifications: false,
        interceptAllEdits: false,
        accentColor: "#ed4245",
    };

    function getSetting(key) {
        return storage.get(key, defaults[key]);
    }

    function setSetting(key, value) {
        storage.set(key, value);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function logError(message, error) {
        console.error(`[SilentEdit] ${message}`, error);
    }

    function getCurrentUserId() {
        try {
            return metro.findByProps("getCurrentUser")?.getCurrentUser?.()?.id;
        } catch {
            return null;
        }
    }

    function getMessage(channelId, messageId) {
        try {
            return metro.findByProps("getMessage")?.getMessage?.(
                channelId,
                messageId,
            );
        } catch {
            return null;
        }
    }

    const MessageActions = metro.findByProps(
        "editMessage",
        "startEditMessage",
    );

    const MessageStore = metro.findByProps("getMessage");
    const UserStore = metro.findByProps("getCurrentUser");
    const ChannelStore = metro.findByProps("getChannel");
    const Constants = metro.findByProps("Endpoints");

    const RestAPI = metro.findByProps("get", "post", "del");

    const LazyActionSheet = metro.findByProps(
        "openLazy",
        "hideActionSheet",
    );

    const { Forms = {} } = ui?.components || {};

    const FormRow =
        Forms.FormRow ||
        metro.findByProps("FormRow")?.FormRow;

    const FormIcon =
        Forms.FormIcon ||
        metro.findByProps("FormIcon")?.FormIcon;

    let pendingSilentEdit = null;
    let editPatchInstalled = false;
    let actionPatchInstalled = false;

    function getMessagesEndpoint(channelId) {
        const endpoint =
            Constants?.Endpoints?.MESSAGES ||
            Constants?.Endpoints?.CHANNEL_MESSAGES ||
            "/channels/:channelId/messages";

        return endpoint.replace(":channelId", channelId);
    }

    async function sendMessage(
        content,
        nonce,
        channelId,
        suppressNotifications,
        messageReference,
    ) {
        if (!RestAPI?.post) {
            throw new Error("Discord REST API POST method was not found");
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
        if (!RestAPI?.del) {
            throw new Error("Discord REST API DELETE method was not found");
        }

        return RestAPI.del({
            url: `${getMessagesEndpoint(channelId)}/${messageId}`,
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

            await sleep(
                Math.max(
                    0,
                    Number(getSetting("deleteDelay")) || 0,
                ),
            );

            if (getSetting("deleteOriginalMessage")) {
                await deleteMessage(channelId, messageId);
            }

            return true;
        } catch (error) {
            logError(
                "Error while silently editing message",
                error,
            );

            return replacementSent;
        }
    }

    function setPendingEdit(channelId, messageId) {
        pendingSilentEdit = {
            channelId,
            messageId,
        };
    }

    function clearPendingEdit() {
        pendingSilentEdit = null;
    }

    function extractEditContent(args) {
        const candidate = args?.[2];

        if (typeof candidate === "string") {
            return candidate;
        }

        if (
            candidate &&
            typeof candidate.content === "string"
        ) {
            return candidate.content;
        }

        return null;
    }

    function installEditPatch() {
        if (
            editPatchInstalled ||
            !MessageActions?.editMessage ||
            !patcher?.instead
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

                    if (
                        !channelId ||
                        !messageId ||
                        content === null
                    ) {
                        return original.apply(this, args);
                    }

                    const pending = pendingSilentEdit;

                    if (
                        pending &&
                        pending.channelId === channelId &&
                        pending.messageId === messageId
                    ) {
                        clearPendingEdit();

                        const message = getMessage(
                            channelId,
                            messageId,
                        );

                        return silentEditMessage(
                            channelId,
                            messageId,
                            content,
                            message?.messageReference,
                        );
                    }

                    if (getSetting("interceptAllEdits")) {
                        const message = getMessage(
                            channelId,
                            messageId,
                        );

                        const currentUserId =
                            getCurrentUserId();

                        if (
                            message &&
                            currentUserId &&
                            message.author?.id ===
                                currentUserId &&
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
                    logError(
                        "Edit interception failed",
                        error,
                    );
                }

                return original.apply(this, args);
            },
        );

        editPatchInstalled = true;
    }

    function getNodeLabel(node) {
        const props = node?.props;

        if (!props) {
            return null;
        }

        const candidates = [
            props.label,
            props.title,
            props.text,
            props.accessibilityLabel,
            props.accessibilityHint,
        ];

        for (const value of candidates) {
            if (typeof value === "string") {
                return value;
            }
        }

        return null;
    }

    function hasPressHandler(node) {
        return Boolean(
            node?.props &&
            (
                typeof node.props.onPress === "function" ||
                typeof node.props.onClick === "function"
            ),
        );
    }

    function isEditAction(node) {
        if (!node || typeof node !== "object") {
            return false;
        }

        const label = getNodeLabel(node);

        if (
            typeof label === "string" &&
            /\bedit\b/i.test(label)
        ) {
            return hasPressHandler(node);
        }

        const typeName =
            node?.type?.displayName ||
            node?.type?.name ||
            "";

        if (
            typeof typeName === "string" &&
            /\bedit\b/i.test(typeName)
        ) {
            return hasPressHandler(node);
        }

        return false;
    }

    function findEditAction(tree) {
        let result = null;

        function walk(node, parentArray) {
            if (result) {
                return;
            }

            if (!node || typeof node !== "object") {
                return;
            }

            if (Array.isArray(node)) {
                for (const child of node) {
                    walk(child, node);

                    if (result) {
                        return;
                    }
                }

                return;
            }

            if (isEditAction(node)) {
                result = {
                    node,
                    parentArray,
                };

                return;
            }

            const props = node.props;

            if (!props) {
                return;
            }

            if (Array.isArray(props.children)) {
                walk(props.children, props.children);

                if (result) {
                    return;
                }
            } else if (props.children) {
                walk(props.children, parentArray);

                if (result) {
                    return;
                }
            }
        }

        walk(tree, null);

        return result;
    }

    function replaceText(value) {
        if (typeof value !== "string") {
            return value;
        }

        if (/\bedit\b/i.test(value)) {
            return "Silent Edit";
        }

        return value;
    }

    function makeSilentEditAction(originalAction, message) {
        const originalProps = originalAction?.props;

        if (!originalProps) {
            return null;
        }

        const handlePress = () => {
            setPendingEdit(
                message.channel_id,
                message.id,
            );

            try {
                LazyActionSheet?.hideActionSheet?.();

                MessageActions?.startEditMessage?.(
                    message.channel_id,
                    message.id,
                    message.content,
                );
            } catch (error) {
                clearPendingEdit();

                logError(
                    "Failed to open Discord edit UI",
                    error,
                );
            }
        };

        const newProps = {
            ...originalProps,

            label: replaceText(originalProps.label),
            title: replaceText(originalProps.title),
            text: replaceText(originalProps.text),
            accessibilityLabel: replaceText(
                originalProps.accessibilityLabel,
            ),

            onPress: handlePress,
            onClick: handlePress,

            disabled: false,
            isDisabled: false,

            __silentEdit: true,
        };

        return React.cloneElement(
            originalAction,
            newProps,
        );
    }

    function injectSilentEdit(tree, message) {
        if (!tree || !message) {
            return tree;
        }

        const currentUserId = getCurrentUserId();

        if (
            !currentUserId ||
            message.author?.id !== currentUserId
        ) {
            return tree;
        }

        const found = findEditAction(tree);

        if (
            !found ||
            !found.node ||
            !found.parentArray
        ) {
            return tree;
        }

        const parent = found.parentArray;

        if (
            parent.some(
                child =>
                    child?.props?.__silentEdit === true,
            )
        ) {
            return tree;
        }

        const silentAction = makeSilentEditAction(
            found.node,
            message,
        );

        if (!silentAction) {
            return tree;
        }

        const index = parent.indexOf(found.node);

        if (index < 0) {
            return tree;
        }

        parent.splice(index + 1, 0, silentAction);

        return tree;
    }

    function getMessageFromRenderArgs(args) {
        const first = args?.[0];

        if (!first) {
            return null;
        }

        if (first.message) {
            return first.message;
        }

        if (first.props?.message) {
            return first.props.message;
        }

        return null;
    }

    function installActionPatch() {
        if (
            actionPatchInstalled ||
            !LazyActionSheet?.openLazy ||
            !patcher?.before
        ) {
            return;
        }

        patcher.before(
            "openLazy",
            LazyActionSheet,
            args => {
                const component = args?.[0];
                const key = args?.[1];

                if (
                    key !==
                    "MessageLongPressActionSheet"
                ) {
                    return;
                }

                if (!component) {
                    return;
                }

                Promise.resolve(component)
                    .then(instance => {
                        if (
                            !instance?.default ||
                            typeof patcher.after !==
                                "function"
                        ) {
                            return;
                        }

                        if (
                            instance.__silentEditPatched
                        ) {
                            return;
                        }

                        instance.__silentEditPatched =
                            true;

                        patcher.after(
                            "default",
                            instance,
                            (renderArgs, tree) => {
                                try {
                                    const message =
                                        getMessageFromRenderArgs(
                                            renderArgs,
                                        );

                                    if (!message) {
                                        return tree;
                                    }

                                    return injectSilentEdit(
                                        tree,
                                        message,
                                    );
                                } catch (error) {
                                    logError(
                                        "Failed to inject Silent Edit action",
                                        error,
                                    );

                                    return tree;
                                }
                            },
                        );
                    })
                    .catch(error => {
                        logError(
                            "Failed to load message action sheet",
                            error,
                        );
                    });
            },
        );

        actionPatchInstalled = true;
    }

    function SettingsComponent() {
        const React = metro.common.React;

        const [deleteOriginalMessage, setDeleteOriginalMessage] =
            React.useState(
                Boolean(
                    getSetting("deleteOriginalMessage"),
                ),
            );

        const [suppressNotifications, setSuppressNotifications] =
            React.useState(
                Boolean(
                    getSetting("suppressNotifications"),
                ),
            );

        const [interceptAllEdits, setInterceptAllEdits] =
            React.useState(
                Boolean(
                    getSetting("interceptAllEdits"),
                ),
            );

        const [deleteDelay, setDeleteDelay] =
            React.useState(
                String(getSetting("deleteDelay")),
            );

        const updateBoolean =
            (key, setter) => value => {
                setter(value);
                setSetting(key, value);
            };

        return React.createElement(
            React.Fragment,
            null,

            FormRow &&
                React.createElement(FormRow, {
                    label: "Delete original message",
                    trailing:
                        Forms.FormSwitch &&
                        React.createElement(
                            Forms.FormSwitch,
                            {
                                value:
                                    deleteOriginalMessage,
                                onValueChange:
                                    updateBoolean(
                                        "deleteOriginalMessage",
                                        setDeleteOriginalMessage,
                                    ),
                            },
                        ),
                }),

            FormRow &&
                React.createElement(FormRow, {
                    label: "Delete delay (ms)",
                    trailing:
                        Forms.FormInput &&
                        React.createElement(
                            Forms.FormInput,
                            {
                                value: deleteDelay,
                                onChange: value => {
                                    setDeleteDelay(
                                        String(value),
                                    );

                                    const parsed =
                                        Number(value);

                                    if (
                                        Number.isFinite(
                                            parsed,
                                        )
                                    ) {
                                        setSetting(
                                            "deleteDelay",
                                            Math.max(
                                                0,
                                                parsed,
                                            ),
                                        );
                                    }
                                },
                            },
                        ),
                }),

            FormRow &&
                React.createElement(FormRow, {
                    label: "Suppress notifications",
                    trailing:
                        Forms.FormSwitch &&
                        React.createElement(
                            Forms.FormSwitch,
                            {
                                value:
                                    suppressNotifications,
                                onValueChange:
                                    updateBoolean(
                                        "suppressNotifications",
                                        setSuppressNotifications,
                                    ),
                            },
                        ),
                }),

            FormRow &&
                React.createElement(FormRow, {
                    label: "Intercept all edits",
                    trailing:
                        Forms.FormSwitch &&
                        React.createElement(
                            Forms.FormSwitch,
                            {
                                value:
                                    interceptAllEdits,
                                onValueChange:
                                    updateBoolean(
                                        "interceptAllEdits",
                                        setInterceptAllEdits,
                                    ),
                            },
                        ),
                }),
        );
    }

    return {
        name: "SilentEdit",

        description:
            '"Silently" edit your own messages without showing the edited tag.',

        authors: [
            {
                name: "kilk",
                id: "1408812084837224488",
            },
        ],

        SettingsComponent,

        start() {
            installEditPatch();
            installActionPatch();
        },

        stop() {
            clearPendingEdit();

            // Patches created through the plugin API are
            // automatically disposed by the host when
            // the plugin stops.
            editPatchInstalled = false;
            actionPatchInstalled = false;
        },
    };
})();
