const plugin = (() => {
    const Revenge = globalThis.revenge;

    if (!Revenge) {
        throw new Error("Revenge runtime was not found");
    }

    const { metro, api, plugin: pluginMeta } = Revenge;
    const React = metro?.common?.React;

    if (!metro || !React) {
        throw new Error("Revenge Metro/React API was not found");
    }

    const patcher = api?.patcher;
    const storage =
        typeof pluginMeta?.createStorage === "function"
            ? pluginMeta.createStorage()
            : {};

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

    /*
     * Discord modules
     */
    const MessageActions =
        metro.findByProps("editMessage", "startEditMessage");

    const MessageStore =
        metro.findByProps("getMessage");

    const UserStore =
        metro.findByProps("getCurrentUser");

    const ChannelStore =
        metro.findByProps("getChannel");

    const Constants =
        metro.findByProps("Endpoints");

    const RestAPI =
        metro.findByProps("get", "post", "del");

    const LazyActionSheet =
        metro.findByProps("openLazy", "hideActionSheet");

    /*
     * Optional Revenge UI components.
     * They are only used for settings, never for the message action.
     */
    const Forms = Revenge.ui?.components?.Forms || {};
    const FormRow =
        Forms.FormRow ||
        metro.findByProps("FormRow")?.FormRow;

    const FormSwitch =
        Forms.FormSwitch ||
        metro.findByProps("FormSwitch")?.FormSwitch;

    let editPatchInstalled = false;
    let actionPatchInstalled = false;

    let pendingSilentEdit = null;
    let pendingTimer = null;

    const activeActionSheetPatches = new Set();

    /*
     * Logging
     */
    function logError(message, error) {
        try {
            pluginMeta?.logger?.error?.(message, error);
        } catch {
            console.error("[SilentEdit]", message, error);
        }
    }

    function logInfo(message) {
        try {
            pluginMeta?.logger?.info?.(message);
        } catch {
            console.log("[SilentEdit]", message);
        }
    }

    /*
     * Discord helpers
     */
    function getCurrentUserId() {
        try {
            return UserStore?.getCurrentUser?.()?.id ?? null;
        } catch {
            return null;
        }
    }

    function getMessage(channelId, messageId) {
        try {
            return MessageStore?.getMessage?.(
                channelId,
                messageId,
            ) ?? null;
        } catch {
            return null;
        }
    }

    function getMessagesEndpoint(channelId) {
        try {
            if (Constants?.Endpoints?.MESSAGES) {
                return Constants.Endpoints.MESSAGES(channelId);
            }
        } catch (error) {
            logError("Failed to resolve messages endpoint", error);
        }

        return `/channels/${channelId}/messages`;
    }

    function getMessageEndpoint(channelId, messageId) {
        try {
            if (Constants?.Endpoints?.MESSAGE) {
                return Constants.Endpoints.MESSAGE(
                    channelId,
                    messageId,
                );
            }
        } catch (error) {
            logError("Failed to resolve message endpoint", error);
        }

        return `/channels/${channelId}/messages/${messageId}`;
    }

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    /*
     * Silent message replacement
     */
    async function sendMessage(
        content,
        nonce,
        channelId,
        suppressNotifications,
        messageReference,
    ) {
        if (!RestAPI?.post) {
            throw new Error("Discord REST POST API was not found");
        }

        const body = {
            content,
            nonce,
            flags: suppressNotifications ? 4096 : 0,
            mobile_network_type: "unknown",
            tts: false,
        };

        if (messageReference) {
            body.message_reference = {
                channel_id:
                    messageReference.channel_id,
                message_id:
                    messageReference.message_id,
                guild_id:
                    messageReference.guild_id,
            };
        }

        return RestAPI.post({
            url: getMessagesEndpoint(channelId),
            body,
        });
    }

    async function deleteMessage(channelId, messageId) {
        if (!RestAPI?.del) {
            throw new Error("Discord REST DELETE API was not found");
        }

        return RestAPI.del({
            url: getMessageEndpoint(
                channelId,
                messageId,
            ),
        });
    }

    async function silentEditMessage(
        channelId,
        messageId,
        content,
        messageReference,
    ) {
        if (
            typeof content !== "string" ||
            content.length === 0
        ) {
            return false;
        }

        let replacementSent = false;

        try {
            await sendMessage(
                content,
                messageId,
                channelId,
                Boolean(
                    getSetting("suppressNotifications"),
                ),
                messageReference,
            );

            replacementSent = true;

            const delay =
                Math.max(
                    0,
                    Number(
                        getSetting("deleteDelay"),
                    ) || 0,
                );

            if (delay > 0) {
                await sleep(delay);
            }

            if (
                getSetting(
                    "deleteOriginalMessage",
                )
            ) {
                await deleteMessage(
                    channelId,
                    messageId,
                );
            }

            return true;
        } catch (error) {
            logError(
                "Silent edit failed",
                error,
            );

            return replacementSent;
        }
    }

    /*
     * Pending explicit Silent Edit action
     */
    function clearPendingEdit() {
        pendingSilentEdit = null;

        if (pendingTimer !== null) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
    }

    function setPendingEdit(
        channelId,
        messageId,
    ) {
        clearPendingEdit();

        pendingSilentEdit = {
            channelId,
            messageId,
        };

        /*
         * Prevent a cancelled edit from affecting a later edit.
         */
        pendingTimer = setTimeout(() => {
            pendingSilentEdit = null;
            pendingTimer = null;
        }, 60_000);
    }

    /*
     * Discord's editMessage signature can vary slightly.
     * Support both string and object content.
     */
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

    /*
     * Intercept Discord's actual edit request.
     *
     * This is intentionally separate from the UI patch.
     */
    function installEditPatch() {
        if (
            editPatchInstalled ||
            !MessageActions?.editMessage ||
            typeof patcher?.instead !== "function"
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
                    const content =
                        extractEditContent(args);

                    /*
                     * Unknown edit signature:
                     * allow Discord to handle it normally.
                     */
                    if (
                        !channelId ||
                        !messageId ||
                        content === null
                    ) {
                        return original.apply(
                            this,
                            args,
                        );
                    }

                    /*
                     * Explicit Silent Edit button.
                     */
                    const pending =
                        pendingSilentEdit;

                    if (
                        pending &&
                        pending.channelId ===
                            channelId &&
                        pending.messageId ===
                            messageId
                    ) {
                        clearPendingEdit();

                        const message =
                            getMessage(
                                channelId,
                                messageId,
                            );

                        return silentEditMessage(
                            channelId,
                            messageId,
                            content,
                            message
                                ?.messageReference,
                        );
                    }

                    /*
                     * Optional global interception.
                     */
                    if (
                        getSetting(
                            "interceptAllEdits",
                        )
                    ) {
                        const message =
                            getMessage(
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
                                message
                                    .messageReference,
                            );
                        }
                    }
                } catch (error) {
                    logError(
                        "Edit interception failed",
                        error,
                    );
                }

                return original.apply(
                    this,
                    args,
                );
            },
        );

        editPatchInstalled = true;
    }

    /*
     * React tree utilities
     *
     * We specifically find Discord's EXISTING Edit action and
     * clone it. This is the important fix for the grey button.
     */
    function isReactElement(value) {
        return (
            value &&
            typeof value === "object" &&
            "props" in value &&
            "type" in value
        );
    }

    function findExistingEditAction(
        root,
        visited = new Set(),
    ) {
        if (!root) return null;

        if (
            typeof root !== "object" &&
            typeof root !== "function"
        ) {
            return null;
        }

        if (visited.has(root)) {
            return null;
        }

        visited.add(root);

        if (isReactElement(root)) {
            const props = root.props;

            const possibleLabels = [
                props?.label,
                props?.title,
                props?.text,
                props?.accessibilityLabel,
            ];

            const isEditLabel =
                possibleLabels.some(
                    value =>
                        typeof value === "string" &&
                        value
                            .trim()
                            .toLowerCase()
                            .includes("edit"),
                );

            const hasPressHandler =
                typeof props?.onPress ===
                    "function" ||
                typeof props?.onClick ===
                    "function";

            if (
                isEditLabel &&
                hasPressHandler
            ) {
                return root;
            }
        }

        /*
         * React children live primarily under props.children,
         * but Discord's generated trees can also expose arrays
         * and other nested values.
         */
        if (Array.isArray(root)) {
            for (const child of root) {
                const result =
                    findExistingEditAction(
                        child,
                        visited,
                    );

                if (result) {
                    return result;
                }
            }

            return null;
        }

        if (
            typeof root === "object" ||
            typeof root === "function"
        ) {
            if (root.props) {
                const result =
                    findExistingEditAction(
                        root.props,
                        visited,
                    );

                if (result) {
                    return result;
                }
            }

            if (
                root.children &&
                root.children !== root
            ) {
                const result =
                    findExistingEditAction(
                        root.children,
                        visited,
                    );

                if (result) {
                    return result;
                }
            }
        }

        return null;
    }

    function findActionArray(
        root,
        visited = new Set(),
    ) {
        if (!root || typeof root !== "object") {
            return null;
        }

        if (visited.has(root)) {
            return null;
        }

        visited.add(root);

        if (Array.isArray(root)) {
            const containsReactElements =
                root.some(isReactElement);

            if (containsReactElements) {
                return root;
            }

            for (const item of root) {
                const result =
                    findActionArray(
                        item,
                        visited,
                    );

                if (result) {
                    return result;
                }
            }

            return null;
        }

        if (root.props) {
            const result =
                findActionArray(
                    root.props,
                    visited,
                );

            if (result) {
                return result;
            }
        }

        return null;
    }

    function hasSilentEditAction(array) {
        return array.some(element => {
            if (!isReactElement(element)) {
                return false;
            }

            const props = element.props;

            return (
                props?.__silentEdit === true ||
                (
                    typeof props?.label ===
                        "string" &&
                    props.label
                        .trim()
                        .toLowerCase() ===
                        "silent edit"
                )
            );
        });
    }

    function injectSilentEdit(
        tree,
        message,
    ) {
        const actionArray =
            findActionArray(tree);

        if (
            !actionArray ||
            hasSilentEditAction(actionArray)
        ) {
            return false;
        }

        /*
         * Find Discord's real Edit item.
         */
        const editElement =
            findExistingEditAction(tree);

        if (!editElement) {
            logError(
                "Could not find Discord's native Edit action",
                null,
            );
            return false;
        }

        const originalProps =
            editElement.props || {};

        const originalPress =
            typeof originalProps.onPress ===
                "function"
                ? originalProps.onPress
                : originalProps.onClick;

        /*
         * Create a completely independent action.
         *
         * All styling, icon handling, layout and enabled
         * behavior come from Discord's existing Edit item.
         */
        const silentPress = () => {
            setPendingEdit(
                message.channel_id,
                message.id,
            );

            try {
                LazyActionSheet?.hideActionSheet?.();

                if (
                    typeof MessageActions
                        ?.startEditMessage !==
                    "function"
                ) {
                    throw new Error(
                        "startEditMessage was not found",
                    );
                }

                MessageActions.startEditMessage(
                    message.channel_id,
                    message.id,
                    message.content,
                );
            } catch (error) {
                clearPendingEdit();

                /*
                 * If Discord's native handler can
                 * safely be called as a fallback,
                 * don't leave the menu in a broken state.
                 */
                try {
                    if (
                        typeof originalPress ===
                        "function"
                    ) {
                        originalPress();
                    }
                } catch {
                    // Ignore fallback failure.
                }

                logError(
                    "Failed to start Silent Edit",
                    error,
                );
            }
        };

        const cloned = React.cloneElement(
            editElement,
            {
                ...originalProps,

                /*
                 * These are deliberately explicit.
                 * In particular, disabled is forced off.
                 */
                disabled: false,
                isDisabled: false,

                label: "Silent Edit",

                onPress:
                    typeof originalProps.onPress ===
                    "function"
                        ? silentPress
                        : undefined,

                onClick:
                    typeof originalProps.onPress ===
                        "function"
                        ? originalProps.onClick
                        : silentPress,

                /*
                 * Marker used to prevent duplicate
                 * insertion into the same sheet.
                 */
                __silentEdit: true,
            },
        );

        actionArray.push(cloned);
        return true;
    }

    /*
     * Action-sheet patch
     */
    function installActionPatch() {
        if (
            actionPatchInstalled ||
            !LazyActionSheet?.openLazy ||
            typeof patcher?.before !== "function"
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
                    const props = args?.[2];

                    /*
                     * Only touch Discord's message
                     * long-press action sheet.
                     */
                    if (
                        key !==
                            "MessageLongPressActionSheet"
                    ) {
                        return;
                    }

                    const message = props?.message;

                    if (!message) {
                        return;
                    }

                    const currentUserId =
                        getCurrentUserId();

                    /*
                     * Silent Edit only makes sense for
                     * the current user's own messages.
                     */
                    if (
                        !currentUserId ||
                        message.author?.id !==
                            currentUserId
                    ) {
                        return;
                    }

                    /*
                     * openLazy receives a Promise for
                     * the actual action-sheet component.
                     */
                    Promise.resolve(component)
                        .then(instance => {
                            if (
                                !instance?.default ||
                                typeof patcher
                                    ?.after !==
                                    "function"
                            ) {
                                return;
                            }

                            /*
                             * Each opened sheet receives
                             * its own short-lived patch.
                             */
                            let finished = false;

                            const unpatch =
                                patcher.after(
                                    "default",
                                    instance,
                                    (_args, tree) => {
                                        if (finished) {
                                            return tree;
                                        }

                                        try {
                                            injectSilentEdit(
                                                tree,
                                                message,
                                            );
                                        } catch (
                                            error
                                        ) {
                                            logError(
                                                "Failed to inject Silent Edit",
                                                error,
                                            );
                                        }

                                        return tree;
                                    },
                                );

                            activeActionSheetPatches.add(
                                unpatch,
                            );

                            /*
                             * The sheet should be long gone
                             * after this point.
                             */
                            setTimeout(() => {
                                if (finished) {
                                    return;
                                }

                                finished = true;
                                activeActionSheetPatches.delete(
                                    unpatch,
                                );

                                try {
                                    unpatch?.();
                                } catch (
                                    error
                                ) {
                                    logError(
                                        "Failed to remove action-sheet patch",
                                        error,
                                    );
                                }
                            }, 15_000);
                        })
                        .catch(error =>
                            logError(
                                "Failed to load message action sheet",
                                error,
                            ),
                        );
                } catch (error) {
                    logError(
                        "Message action interception failed",
                        error,
                    );
                }
            },
        );

        actionPatchInstalled = true;
    }

    /*
     * Settings
     */
    function settingRow(
        title,
        description,
        value,
        onToggle,
    ) {
        if (FormSwitch) {
            return React.createElement(
                FormSwitch,
                {
                    title,
                    description,
                    value: Boolean(value),
                    onValueChange: onToggle,
                },
            );
        }

        if (FormRow) {
            return React.createElement(
                FormRow,
                {
                    label:
                        `${title}: ` +
                        (value ? "On" : "Off"),
                    subLabel: description,
                    onPress: () =>
                        onToggle(!value),
                },
            );
        }

        return null;
    }

    function SettingsComponent() {
        const [, forceUpdate] =
            React.useReducer(
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
                getSetting(
                    "deleteOriginalMessage",
                ),
                toggle(
                    "deleteOriginalMessage",
                ),
            ),

            settingRow(
                "Suppress notifications",
                "Adds the silent notification flag to the replacement message.",
                getSetting(
                    "suppressNotifications",
                ),
                toggle(
                    "suppressNotifications",
                ),
            ),

            settingRow(
                "Intercept all edits",
                "Silently intercept normal edits too, including Up Arrow editing.",
                getSetting(
                    "interceptAllEdits",
                ),
                toggle(
                    "interceptAllEdits",
                ),
            ),
        ].filter(Boolean);

        if (FormRow) {
            const delays = [
                0,
                250,
                500,
                1000,
                2000,
            ];

            const currentDelay =
                Number(
                    getSetting("deleteDelay"),
                ) || 0;

            const currentIndex =
                delays.indexOf(currentDelay);

            const index =
                currentIndex < 0
                    ? 0
                    : currentIndex;

            const nextDelay =
                delays[
                    (index + 1) %
                        delays.length
                ];

            children.push(
                React.createElement(
                    FormRow,
                    {
                        label:
                            `Delete delay: ` +
                            `${currentDelay} ms`,
                        subLabel:
                            `Tap to cycle: ` +
                            `${delays.join(", ")} ms.`,
                        onPress: () => {
                            storage.deleteDelay =
                                nextDelay;

                            forceUpdate();
                        },
                    },
                ),
            );

            const colors = [
                "#ed4245",
                "#5865f2",
                "#57f287",
                "#fee75c",
                "#eb459e",
                "#ffffff",
            ];

            const currentColor =
                getSetting(
                    "accentColor",
                );

            const colorIndex =
                Math.max(
                    0,
                    colors.indexOf(
                        currentColor,
                    ),
                );

            const nextColor =
                colors[
                    (colorIndex + 1) %
                        colors.length
                ];

            children.push(
                React.createElement(
                    FormRow,
                    {
                        label:
                            `Accent color: ` +
                            `${currentColor}`,
                        subLabel:
                            "Tap to cycle presets.",
                        onPress: () => {
                            storage.accentColor =
                                nextColor;

                            forceUpdate();
                        },
                    },
                ),
            );
        }

        return React.createElement(
            React.Fragment,
            null,
            ...children,
        );
    }

    /*
     * Lifecycle
     */
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

            if (!patcher) {
                throw new Error(
                    "Revenge patcher was not found",
                );
            }

            installActionPatch();
            installEditPatch();

            logInfo("SilentEdit loaded");
        },

        stop() {
            clearPendingEdit();

            for (
                const unpatch of
                activeActionSheetPatches
            ) {
                try {
                    unpatch?.();
                } catch (error) {
                    logError(
                        "Failed to remove action-sheet patch",
                        error,
                    );
                }
            }

            activeActionSheetPatches.clear();

            /*
             * Revenge's patcher owns the permanent
             * plugin patches, so stopping the plugin
             * disposes them normally.
             */
            editPatchInstalled = false;
            actionPatchInstalled = false;

            logInfo("SilentEdit unloaded");
        },

        SettingsComponent,
    };
})();

plugin;
