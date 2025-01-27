require("dotenv").config()
const config = require('../Config')
const express = require('express')
const router = express.Router()
const sequelize = require('sequelize')
const Op = sequelize.Op
const { v4: uuidv4 } = require('uuid')
const sgMail = require('@sendgrid/mail')
sgMail.setApiKey(process.env.SENDGRID_API_KEY)
const authenticateToken = require('../middleware/authenticateToken')
const {
    Holon,
    VerticalHolonRelationship,
    HolonHandle, // InheritedSpaceId
    HolonUser, // SpaceUserRelationship
    User,
    UserEvent,
    Post,
    Reaction,
    Link,
    Notification,
    SpaceNotification,
    GlassBeadGame,
    GlassBead,
    Event,
    PostImage,
    Weave
} = require('../models')
const {
    postAttributes,
    totalSpaceFollowers,
    totalSpaceComments,
    totalSpaceReactions,
    totalSpaceLikes,
    totalSpaceRatings,
    totalSpacePosts,
    totalSpaceChildren,
    totalUserPosts,
    totalUserComments,
    asyncForEach
} = require('../GlobalConstants')

const spaceAttributes = [
    'id',
    'handle',
    'name',
    'description',
    'flagImagePath',
    'coverImagePath',
    'createdAt',
    totalSpaceFollowers,
    totalSpaceComments,
    totalSpaceReactions,
    totalSpaceLikes,
    totalSpaceRatings,
    totalSpacePosts,
    totalSpaceChildren
]

const userAttributes = [
    'id',
    'handle',
    'name',
    'bio',
    'flagImagePath',
    'coverImagePath',
    'createdAt',
    totalUserPosts,
    totalUserComments
]

const firstGenLimit = 7
const secondGenLimit = 3
const thirdGenLimit = 3
const fourthGenLimit = 3

function findStartDate(timeRange) {
    let timeOffset = Date.now()
    if (timeRange === 'Last Year') { timeOffset = (24*60*60*1000) * 365 }
    if (timeRange === 'Last Month') { timeOffset = (24*60*60*1000) * 30 }
    if (timeRange === 'Last Week') { timeOffset = (24*60*60*1000) * 7 }
    if (timeRange === 'Last 24 Hours') { timeOffset = 24*60*60*1000 }
    if (timeRange === 'Last Hour') { timeOffset = 60*60*1000 }
    let startDate = new Date()
    startDate.setTime(startDate.getTime() - timeOffset)
    return startDate
}

function findOrder(sortOrder, sortBy) {
    let direction, order
    if (sortOrder === 'Ascending') { direction = 'ASC' } else { direction = 'DESC' }
    if (sortBy === 'Date') { order = [['createdAt', direction]] }
    else { order = [[sequelize.literal(`total${sortBy}`), direction], ['createdAt', 'DESC']] }
    return order
}

function findSpaceFirstAttributes(sortBy) {
    let firstAttributes = ['id']
    if (sortBy === 'Followers') firstAttributes.push(totalSpaceFollowers)
    if (sortBy === 'Posts') firstAttributes.push(totalSpacePosts)
    if (sortBy === 'Comments') firstAttributes.push(totalSpaceComments)
    if (sortBy === 'Reactions') firstAttributes.push(totalSpaceReactions)
    if (sortBy === 'Likes') firstAttributes.push(totalSpaceLikes)
    if (sortBy === 'Ratings') firstAttributes.push(totalSpaceRatings)
    return firstAttributes
}

function findSpaceWhere(spaceId, depth, timeRange, searchQuery) {
    let where
    if (depth === 'All Contained Spaces') { 
        where =
        { 
            '$HolonHandles.id$': spaceId,
            id: { [Op.ne]: [spaceId] },
            state: 'active',
            createdAt: { [Op.between]: [findStartDate(timeRange), Date.now()] },
            [Op.or]: [
                { handle: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { name: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { description: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } }
            ]
        } 
    }
    if (depth === 'Only Direct Descendants') {
        where =
        { 
            '$DirectParentHolons.id$': spaceId,
            state: 'active',
            createdAt: { [Op.between]: [findStartDate(timeRange), Date.now()] },
            [Op.or]: [
                { handle: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { name: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { description: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } }
            ]
        }
    }
    return where
}

function findSpaceInclude(depth) {
    let include
    if (depth === 'All Contained Spaces') { 
        include = [{ 
            model: Holon,
            as: 'HolonHandles',
            attributes: [],
            through: { attributes: [], where: { state: 'open' } }
        }]
    }
    if (depth === 'Only Direct Descendants') { 
        include = [{ 
            model: Holon,
            as: 'DirectParentHolons',
            attributes: [],
            through: { attributes: [], where: { state: 'open' } },
        }]
    }
    return include
}

function findUserFirstAttributes(sortBy) {
    let firstAttributes = ['id']
    if (sortBy === 'Posts') firstAttributes.push(totalUserPosts)
    if (sortBy === 'Comments') firstAttributes.push(totalUserComments)
    return firstAttributes
}

function findTotalSpaceResults(depth, searchQuery, timeRange) {
    function formatDate(date) {
        const d = date.toISOString().split(/[-T:.]/)
        return `${d[0]}-${d[1]}-${d[2]} ${d[3]}:${d[4]}:${d[5]}`
    }
    const startDate = formatDate(findStartDate(timeRange))
    const now = formatDate(new Date)

    if (depth === 'All Contained Spaces') {
        return [sequelize.literal(`(
            SELECT COUNT(*)
                FROM Holons s
                WHERE s.id != Holon.id
                AND s.id IN (
                    SELECT HolonHandles.holonAId
                    FROM HolonHandles
                    RIGHT JOIN Holons
                    ON HolonHandles.holonAId = Holons.id
                    WHERE HolonHandles.holonBId = Holon.id
                    AND HolonHandles.state = 'open'
                ) AND (
                    s.handle LIKE '%${searchQuery}%'
                    OR s.name LIKE '%${searchQuery}%'
                    OR s.description LIKE '%${searchQuery}%'
                ) AND s.createdAt BETWEEN '${startDate}' AND '${now}'
            )`), 'totalResults'
        ]
    } else {
        return [sequelize.literal(`(
            SELECT COUNT(*)
                FROM Holons s
                WHERE s.id IN (
                    SELECT vhr.holonBId
                    FROM VerticalHolonRelationships vhr
                    RIGHT JOIN Holons
                    ON vhr.holonAId = Holon.id
                    WHERE vhr.state = 'open'
                ) AND (
                    s.handle LIKE '%${searchQuery}%'
                    OR s.name LIKE '%${searchQuery}%'
                    OR s.description LIKE '%${searchQuery}%'
                ) AND s.createdAt BETWEEN '${startDate}' AND '${now}'
            )`), 'totalResults'
        ]
    }
}

// GET
router.get('/homepage-highlights', async (req, res) => {
    const totals = Holon.findOne({
        where: { id: 1 },
        attributes: [
            [sequelize.literal(`(SELECT COUNT(*) FROM Posts WHERE Posts.state = 'visible')`), 'totalPosts'],
            [sequelize.literal(`(SELECT COUNT(*) FROM Holons WHERE Holons.state = 'active')`), 'totalSpaces'],
            [sequelize.literal(`(SELECT COUNT(*) FROM Users WHERE Users.emailVerified = true AND Users.state = 'active')`), 'totalUsers'],
        ]
    })

    const posts = Post.findAll({
        where: {
            state: 'visible',
            urlImage: { [Op.ne]: null }
        },
        attributes: ['urlImage'],
        order: [['createdAt', 'DESC']],
        limit: 3,
    })

    const spaces = Holon.findAll({
        where: {
            // id: { [Op.ne]: [1] },
            flagImagePath: { [Op.ne]: null }
        },
        attributes: ['flagImagePath'],
        order: [['createdAt', 'DESC']],
        limit: 3,
    })

    const users = User.findAll({
        where: {
            state: 'active',
            emailVerified: true,
            flagImagePath: { [Op.ne]: null }
        },
        attributes: ['flagImagePath'],
        order: [['createdAt', 'DESC']],
        limit: 3
    })

    Promise
        .all([totals, posts, spaces, users])
        .then(data => res.send({
            totals: data[0],
            posts: data[1].map(p => p.urlImage),
            spaces: data[2].map(s => s.flagImagePath),
            users: data[3].map(u => u.flagImagePath)
        }))
})

router.get('/space-data', async (req, res) => {
    const { handle } = req.query
    const totalUsers = handle === 'all'
        ? [sequelize.literal(`(SELECT COUNT(*) FROM Users WHERE Users.emailVerified = true AND Users.state = 'active')`), 'totalUsers']
        : [sequelize.literal(`(
            SELECT COUNT(*)
                FROM Users
                WHERE Users.emailVerified = true
                AND Users.state = 'active'
                AND Users.id IN (
                    SELECT HolonUsers.userId
                    FROM HolonUsers
                    RIGHT JOIN Users
                    ON HolonUsers.userId = Users.id
                    WHERE HolonUsers.holonId = Holon.id
                    AND HolonUsers.state = 'active'
                )
            )`), 'totalUsers'
        ]
    const spaceData = await Holon.findOne({ 
        where: { handle: handle, state: 'active' },
        attributes: [
            'id', 'handle', 'name', 'description', 'flagImagePath', 'coverImagePath', 'createdAt',
            [sequelize.literal(`(
                SELECT COUNT(*)
                    FROM Holons
                    WHERE Holons.handle != Holon.handle
                    AND Holons.state = 'active'
                    AND Holons.id IN (
                        SELECT HolonHandles.holonAId
                        FROM HolonHandles
                        RIGHT JOIN Holons
                        ON HolonHandles.holonAId = Holons.id
                        WHERE HolonHandles.holonBId = Holon.id
                    )
                )`), 'totalSpaces'
            ],
            [sequelize.literal(`(
                SELECT COUNT(*)
                    FROM Posts
                    WHERE Posts.state = 'visible'
                    AND Posts.id IN (
                        SELECT PostHolons.postId
                        FROM PostHolons
                        RIGHT JOIN Posts
                        ON PostHolons.postId = Posts.id
                        WHERE PostHolons.HolonId = Holon.id
                    )
                )`), 'totalPosts'
            ],
            totalUsers
        ],
        include: [
            {
                model: Holon,
                as: 'DirectParentHolons',
                attributes: ['id', 'handle', 'name', 'description', 'flagImagePath', totalSpaceChildren],
                through: { attributes: [], where: { state: 'open' } },
            },
            {
                model: Holon,
                as: 'HolonHandles',
                attributes: ['handle'],
                through: { attributes: [] }
            },
            {
                model: User,
                as: 'Creator',
                attributes: ['id', 'handle', 'name', 'flagImagePath']
            },
            {
                model: User,
                as: 'Moderators',
                attributes: ['id', 'handle', 'name', 'flagImagePath'],
                through: { where: { relationship: 'moderator', state: 'active' }, attributes: [] }
            },
        ],
    })

    if (!spaceData) res.status(404).send({ message: 'Space not found' })
    else {
        // child spaces and latest users retrieved seperately so limit and order can be applied (not allowed for M:M includes in Sequelize)
        const childSpaces = await Holon.findAll({
            where: { '$DirectParentHolons.id$': spaceData.id, state: 'active' },
            attributes: ['id', 'handle', 'name', 'flagImagePath', totalSpaceLikes, totalSpaceChildren],
            order: [[ sequelize.literal(`totalLikes`), 'DESC'], ['createdAt', 'DESC']],
            limit: 50,
            subQuery: false,
            include: [{
                model: Holon,
                as: 'DirectParentHolons',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' }  }
            }],
        })
        spaceData.setDataValue('DirectChildHolons', childSpaces)
        if (spaceData.id === 1) {
            // get latest 3 users for root space
            const latestUsers = await User.findAll({
                where: { state: 'active', emailVerified: true, flagImagePath: { [Op.ne]: null } },
                attributes: ['flagImagePath'],
                order: [['createdAt', 'DESC']],
                limit: 3
            })
            spaceData.setDataValue('LatestUsers', latestUsers)
        } else {
            // get latest 3 users for other spaces
            const latestUsers = await User.findAll({
                where: { '$UserHolons.id$': spaceData.id, state: 'active', emailVerified: true },
                attributes: ['flagImagePath', 'createdAt'],
                order: [['createdAt', 'DESC']],
                // mods added to limit to prevent duplicate results causing issues (unable to get 'distinct' setting working)
                limit: 3 + spaceData.Moderators.length,
                subQuery: false,
                include: [{ 
                    model: Holon,
                    as: 'UserHolons',
                    attributes: [],
                    through: { where: { state: 'active' }, attributes: [] }
                }],
            })
            spaceData.setDataValue('LatestUsers', latestUsers)
        }
        res.status(200).send(spaceData)
    }
})

// todo: potentially merge with user posts: get('/posts')
router.get('/space-posts', (req, res) => {
    const { accountId, spaceId, timeRange, postType, sortBy, sortOrder, depth, searchQuery, limit, offset } = req.query

    function findStartDate() {
        let offset = undefined
        if (timeRange === 'Last Year') { offset = (24*60*60*1000) * 365 }
        if (timeRange === 'Last Month') { offset = (24*60*60*1000) * 30 }
        if (timeRange === 'Last Week') { offset = (24*60*60*1000) * 7 }
        if (timeRange === 'Last 24 Hours') { offset = 24*60*60*1000 }
        if (timeRange === 'Last Hour') { offset = 60*60*1000 }
        var startDate = new Date()
        startDate.setTime(startDate.getTime() - offset)
        return startDate
    }

    function findType() {
        return postType === 'All Types'
            ? ['text', 'url', 'image', 'audio', 'event', 'glass-bead-game', 'string', 'weave', 'prism']
            : postType.replace(/\s+/g, '-').toLowerCase()
    }

    function findOrder() {
        let direction, order
        if (sortOrder === 'Ascending') { direction = 'ASC' } else { direction = 'DESC' }
        if (sortBy === 'Date') { order = [['createdAt', direction]] }
        if (sortBy === 'Reactions') { order = [[sequelize.literal(`totalReactions`), direction], ['createdAt', 'DESC']] }
        if (sortBy !== 'Reactions' && sortBy !== 'Date') { order = [[sequelize.literal(`total${sortBy}`), direction], ['createdAt', 'DESC']] }
        return order
    }

    function findFirstAttributes() {
        let firstAttributes = ['id']
        if (sortBy === 'Comments') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Comments AS Comment WHERE Comment.state = 'visible' AND Comment.postId = Post.id)`
            ),'totalComments'
        ])}
        if (sortBy === 'Reactions') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type != 'vote' AND Reaction.state = 'active')`
            ),'totalReactions'
        ])}
        if (sortBy === 'Likes') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type = 'like' AND Reaction.state = 'active')`
            ),'totalLikes'
        ])}
        if (sortBy === 'Ratings') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type = 'rating' AND Reaction.state = 'active')`
            ),'totalRatings'
        ])}
        if (sortBy === 'Reposts') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type = 'repost' AND Reaction.state = 'active')`
            ),'totalReposts'
        ])}
        return firstAttributes
    }

    function findThrough() {
        let through
        if (depth === 'All Contained Posts') {
            through = {
                where: {
                    [Op.or]: [
                        { relationship: 'direct' },
                        { relationship: 'indirect' },
                    ]
                },
                attributes: []
            }
        }
        if (depth === 'Only Direct Posts') {
            through = {
                where: { relationship: 'direct' },
                attributes: []
            }
        }
        return through
    }

    let startDate = findStartDate()
    let type = findType()
    let order = findOrder()
    let firstAttributes = findFirstAttributes()
    let through = findThrough()

    // Double query required to to prevent results and pagination being effected by top level where clause.
    // Intial query used to find correct posts with calculated stats and pagination applied.
    // Second query used to return related models.
    Post.findAll({
        subQuery: false,
        where: { 
            '$AllIncludedSpaces.id$': spaceId,
            state: 'visible',
            createdAt: { [Op.between]: [startDate, Date.now()] },
            type,
            [Op.or]: [
                { text: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlTitle: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlDescription: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlDomain: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { '$GlassBeadGame.topic$': { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
            ],
        },
        order,
        limit: Number(limit),
        offset: Number(offset),
        attributes: firstAttributes,
        include: [
            {
                model: Holon,
                as: 'AllIncludedSpaces',
                attributes: [],
                through,
            },
            {
                model: GlassBeadGame,
                required: false,
                attributes: ['topic', 'topicGroup'],
            },
        ]
    })
    .then(posts => {
        // Add account reaction data to post attributes
        let mainAttributes = [
            ...postAttributes,
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Reactions
                AS Reaction
                WHERE Reaction.postId = Post.id
                AND Reaction.userId = ${accountId}
                AND Reaction.type = 'like'
                AND Reaction.state = 'active'
                )`),'accountLike'
            ],
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Reactions
                AS Reaction
                WHERE Reaction.postId = Post.id
                AND Reaction.userId = ${accountId}
                AND Reaction.type = 'rating'
                AND Reaction.state = 'active'
                )`),'accountRating'
            ],
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Reactions
                AS Reaction
                WHERE Reaction.postId = Post.id
                AND Reaction.userId = ${accountId}
                AND Reaction.type = 'repost'
                AND Reaction.state = 'active'
                )`),'accountRepost'
            ],
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Links
                AS Link
                WHERE Link.state = 'visible'
                AND Link.type != 'string-post'
                AND Link.creatorId = ${accountId}
                AND (Link.itemAId = Post.id OR Link.itemBId = Post.id)
                )`),'accountLink'
            ],
        ]
        return Post.findAll({ 
            where: { id: posts.map(post => post.id) },
            attributes: mainAttributes,
            order,
            include: [
                {
                    model: User,
                    as: 'Creator',
                    attributes: ['id', 'handle', 'name', 'flagImagePath'],
                },
                {
                    model: Holon,
                    as: 'DirectSpaces',
                    attributes: ['id', 'handle', 'name', 'flagImagePath', 'state'],
                    through: { where: { relationship: 'direct' }, attributes: ['type'] },
                },
                {
                    model: Holon,
                    as: 'IndirectSpaces',
                    attributes: ['id', 'handle', 'name', 'state', 'flagImagePath'],
                    through: { where: { relationship: 'indirect' }, attributes: ['type'] },
                },
                { 
                    model: Reaction,
                    where: { state: 'active' },
                    required: false,
                    attributes: ['id', 'type', 'value'],
                    include: [
                        {
                            model: User,
                            as: 'Creator',
                            attributes: ['id', 'handle', 'name', 'flagImagePath']
                        },
                        {
                            model: Holon,
                            as: 'Space',
                            attributes: ['id', 'handle', 'name', 'flagImagePath']
                        },
                    ]
                },
                {
                    model: Link,
                    as: 'OutgoingLinks',
                    where: { state: 'visible', type: { [Op.not]: 'string-post' } },
                    required: false,
                    attributes: ['id'],
                    include: [
                        { 
                            model: User,
                            as: 'Creator',
                            attributes: ['id', 'handle', 'name', 'flagImagePath'],
                        },
                        { 
                            model: Post,
                            as: 'PostB',
                            attributes: ['id'],
                            include: [
                                { 
                                    model: User,
                                    as: 'Creator',
                                    attributes: ['handle', 'name', 'flagImagePath'],
                                }
                            ]
                        },
                    ]
                },
                {
                    model: Link,
                    as: 'IncomingLinks',
                    where: { state: 'visible' },
                    required: false,
                    attributes: ['id'],
                    include: [
                        { 
                            model: User,
                            as: 'Creator',
                            attributes: ['id', 'handle', 'name', 'flagImagePath'],
                        },
                        { 
                            model: Post,
                            as: 'PostA',
                            attributes: ['id'],
                            include: [
                                { 
                                    model: User,
                                    as: 'Creator',
                                    attributes: ['handle', 'name', 'flagImagePath'],
                                }
                            ]
                        },
                    ]
                },
                {
                    model: PostImage,
                    required: false,
                },
                {
                    model: Event,
                    required: false,
                    include: [
                        {
                            model: User,
                            as: 'Going',
                            attributes: ['id', 'handle', 'name', 'flagImagePath'],
                            through: { where: { relationship: 'going', state: 'active' }, attributes: [] },
                        },
                        {
                            model: User,
                            as: 'Interested',
                            attributes: ['id', 'handle', 'name', 'flagImagePath'],
                            through: { where: { relationship: 'interested', state: 'active' }, attributes: [] },
                        }
                    ]
                },
                {
                    model: GlassBeadGame,
                    required: false,
                    attributes: ['topic', 'topicGroup', 'topicImage'],
                    include: [{ 
                        model: GlassBead,
                        where: { state: 'visible' },
                        required: false,
                        include: [{
                            model: User,
                            as: 'user',
                            attributes: ['handle', 'name', 'flagImagePath']
                        }]
                    }]
                },
                {
                    model: Post,
                    as: 'StringPosts',
                    attributes: ['id', 'type', 'text', 'url', 'urlTitle', 'urlImage', 'urlDomain', 'urlDescription'],
                    through: { where: { state: 'visible' }, attributes: ['index'] },
                    required: false,
                    include: [
                        {
                            model: User,
                            as: 'Creator',
                            attributes: ['handle', 'name', 'flagImagePath']
                        },
                        { 
                            model: PostImage,
                            required: false,
                            attributes: ['caption', 'createdAt', 'id', 'index', 'url']
                        }
                    ]
                },
                {
                    model: Weave,
                    attributes: ['numberOfMoves', 'numberOfTurns', 'moveDuration', 'allowedPostTypes', 'privacy'],
                    required: false
                },
                {
                    model: User,
                    as: 'StringPlayers',
                    attributes: ['id', 'handle', 'name', 'flagImagePath'],
                    through: { where: { type: 'weave' }, attributes: ['index', 'state'] },
                    required: false
                },
            ]
        })
        .then(posts => {
            posts.forEach(post => {
                // save type and remove redundant PostHolon objects
                post.DirectSpaces.forEach(space => {
                    space.setDataValue('type', space.dataValues.PostHolon.type)
                    delete space.dataValues.PostHolon
                })
                post.IndirectSpaces.forEach(space => {
                    space.setDataValue('type', space.dataValues.PostHolon.type)
                    delete space.dataValues.PostHolon
                })
                // convert SQL numeric booleans to JS booleans
                post.setDataValue('accountLike', !!post.dataValues.accountLike)
                post.setDataValue('accountRating', !!post.dataValues.accountRating)
                post.setDataValue('accountRepost', !!post.dataValues.accountRepost)
                post.setDataValue('accountLink', !!post.dataValues.accountLink)
                // post.setDataValue('accountFollowingEvent', !!post.dataValues.accountFollowingEvent)
            })
            let holonPosts = {
                // totalMatchingPosts,
                posts
            }
            return holonPosts
        })
    })
    .then(data => { res.json(data) })
    .catch(err => console.log(err))
})

router.get('/post-map-data', async (req, res) => {
    const { accountId, spaceId, timeRange, postType, sortBy, sortOrder, depth, searchQuery, limit, offset } = req.query

    function findStartDate() {
        let offset = undefined
        if (timeRange === 'Last Year') { offset = (24*60*60*1000) * 365 }
        if (timeRange === 'Last Month') { offset = (24*60*60*1000) * 30 }
        if (timeRange === 'Last Week') { offset = (24*60*60*1000) * 7 }
        if (timeRange === 'Last 24 Hours') { offset = 24*60*60*1000 }
        if (timeRange === 'Last Hour') { offset = 60*60*1000 }
        var startDate = new Date()
        startDate.setTime(startDate.getTime() - offset)
        return startDate
    }

    function findType() {
        return postType === 'All Types'
            ? ['text', 'url', 'image', 'audio', 'event', 'glass-bead-game', 'string', 'weave', 'prism']
            : postType.replace(/\s+/g, '-').toLowerCase()
    }

    function findOrder() {
        let direction, order
        if (sortOrder === 'Ascending') { direction = 'ASC' } else { direction = 'DESC' }
        if (sortBy === 'Date') { order = [['createdAt', direction]] }
        if (sortBy === 'Reactions') { order = [[sequelize.literal(`totalReactions`), direction], ['createdAt', 'DESC']] }
        if (sortBy !== 'Reactions' && sortBy !== 'Date') { order = [[sequelize.literal(`total${sortBy}`), direction], ['createdAt', 'DESC']] }
        return order
    }

    function findFirstAttributes() {
        let firstAttributes = ['id']
        if (sortBy === 'Comments') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Comments AS Comment WHERE Comment.state = 'visible' AND Comment.postId = Post.id)`
            ),'totalComments'
        ])}
        if (sortBy === 'Reactions') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type != 'vote' AND Reaction.state = 'active')`
            ),'totalReactions'
        ])}
        if (sortBy === 'Likes') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type = 'like' AND Reaction.state = 'active')`
            ),'totalLikes'
        ])}
        if (sortBy === 'Ratings') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type = 'rating' AND Reaction.state = 'active')`
            ),'totalRatings'
        ])}
        if (sortBy === 'Reposts') { firstAttributes.push([sequelize.literal(
            `(SELECT COUNT(*) FROM Reactions AS Reaction WHERE Reaction.postId = Post.id AND Reaction.type = 'repost' AND Reaction.state = 'active')`
            ),'totalReposts'
        ])}
        return firstAttributes
    }

    function findThrough() {
        let through
        if (depth === 'All Contained Posts') {
            through = {
                where: {
                    [Op.or]: [
                        { relationship: 'direct' },
                        { relationship: 'indirect' },
                    ]
                },
                attributes: []
            }
        }
        if (depth === 'Only Direct Posts') {
            through = {
                where: { relationship: 'direct' },
                attributes: []
            }
        }
        return through
    }

    let startDate = findStartDate()
    let type = findType()
    let order = findOrder()
    let firstAttributes = findFirstAttributes()
    let through = findThrough()

    const totalMatchingPosts = await Post.count({
        subQuery: false,
        where: { 
            '$AllIncludedSpaces.id$': spaceId,
            state: 'visible',
            createdAt: { [Op.between]: [startDate, Date.now()] },
            type,
            [Op.or]: [
                { text: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlTitle: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlDescription: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlDomain: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { '$GlassBeadGame.topic$': { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
            ],
        },
        order,
        attributes: firstAttributes,
        include: [
            {
                model: Holon,
                as: 'AllIncludedSpaces',
                attributes: [],
                through,
            },
            {
                model: GlassBeadGame,
                required: false,
                attributes: ['topic', 'topicGroup'],
            },
        ]
    })

    // Double query required to to prevent results and pagination being effected by top level where clause.
    // Intial query used to find correct posts with calculated stats and pagination applied.
    // Second query used to return related models.
    Post.findAll({
        subQuery: false,
        where: { 
            '$AllIncludedSpaces.id$': spaceId,
            state: 'visible',
            createdAt: { [Op.between]: [startDate, Date.now()] },
            type,
            [Op.or]: [
                { text: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlTitle: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlDescription: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { urlDomain: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { '$GlassBeadGame.topic$': { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
            ],
        },
        order,
        limit: Number(limit),
        offset: Number(offset),
        attributes: firstAttributes,
        include: [
            {
                model: Holon,
                as: 'AllIncludedSpaces',
                attributes: [],
                through,
            },
            {
                model: GlassBeadGame,
                required: false,
                attributes: ['topic', 'topicGroup'],
            },
        ]
    })
    .then(posts => {
        // Add account reaction data to post attributes
        let mainAttributes = [
            ...postAttributes,
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Reactions
                AS Reaction
                WHERE Reaction.postId = Post.id
                AND Reaction.userId = ${accountId}
                AND Reaction.type = 'like'
                AND Reaction.state = 'active'
                )`),'accountLike'
            ],
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Reactions
                AS Reaction
                WHERE Reaction.postId = Post.id
                AND Reaction.userId = ${accountId}
                AND Reaction.type = 'rating'
                AND Reaction.state = 'active'
                )`),'accountRating'
            ],
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Reactions
                AS Reaction
                WHERE Reaction.postId = Post.id
                AND Reaction.userId = ${accountId}
                AND Reaction.type = 'repost'
                AND Reaction.state = 'active'
                )`),'accountRepost'
            ],
            [sequelize.literal(`(
                SELECT COUNT(*) > 0
                FROM Links
                AS Link
                WHERE Link.state = 'visible'
                AND Link.creatorId = ${accountId}
                AND (Link.itemAId = Post.id OR Link.itemBId = Post.id)
                )`),'accountLink'
            ],
        ]
        return Post.findAll({ 
            where: { id: posts.map(post => post.id) },
            attributes: mainAttributes,
            order,
            include: [
                {
                    model: Link,
                    as: 'OutgoingLinks',
                    where: { state: 'visible' },
                    required: false,
                    attributes: ['id', 'description'],
                    include: [
                        { 
                            model: Post,
                            as: 'PostB',
                            attributes: ['id'],
                        },
                    ]
                },
                {
                    model: Link,
                    as: 'IncomingLinks',
                    where: { state: 'visible' },
                    required: false,
                    attributes: ['id'],
                    include: [
                        { 
                            model: Post,
                            as: 'PostA',
                            attributes: ['id'],
                        },
                    ]
                },
                {
                    model: PostImage,
                    required: false,
                    attributes: ['url'],
                    limit: 1,
                    order: [['index', 'ASC']]
                },
            ],
            required: false
        })
        .then(posts => {
            posts.forEach(post => {
                // convert SQL numeric booleans to JS booleans
                post.setDataValue('accountLike', !!post.dataValues.accountLike)
                post.setDataValue('accountRating', !!post.dataValues.accountRating)
                post.setDataValue('accountRepost', !!post.dataValues.accountRepost)
                post.setDataValue('accountLink', !!post.dataValues.accountLink)
                // post.setDataValue('accountFollowingEvent', !!post.dataValues.accountFollowingEvent)
            })
            let postMapData = {
                totalMatchingPosts,
                posts
            }
            return postMapData
        })
    })
    .then(data => { res.json(data) })
    .catch(err => console.log(err))
})

router.get('/space-spaces', (req, res) => {
    const {
        accountId,
        spaceId,
        timeRange,
        spaceType,
        sortBy,
        sortOrder,
        depth,
        searchQuery,
        limit,
        offset
    } = req.query

    console.log('req.query: ', req.query)

    // Double query required to to prevent results and pagination being effected by top level where clause.
    // Intial query used to find correct posts with calculated stats and pagination applied.
    // Second query used to return related models.
    Holon.findAll({
        where: findSpaceWhere(spaceId, depth, timeRange, searchQuery),
        order: findOrder(sortOrder, sortBy),
        attributes: findSpaceFirstAttributes(sortBy),
        include: findSpaceInclude(depth),
        limit: Number(limit) || null,
        offset: Number(offset),
        subQuery: false,
    })
    .then(holons => {
        Holon.findAll({ 
            where: { id: holons.map(holon => holon.id) },
            order: findOrder(sortOrder, sortBy),
            attributes: spaceAttributes,
        }).then(data => { res.json(data) })
    })
    .catch(err => console.log(err))
})

router.get('/space-users', (req, res) => {
    const { accountId, spaceId, timeRange, userType, sortBy, sortOrder, searchQuery, limit, offset } = req.query

    // console.log('req.query: ', req.query)

    User.findAll({
        where: { 
            '$FollowedHolons.id$': spaceId,
            state: 'active',
            emailVerified: true,
            createdAt: { [Op.between]: [findStartDate(timeRange), Date.now()] },
            [Op.or]: [
                { handle: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { name: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } },
                { bio: { [Op.like]: `%${searchQuery ? searchQuery : ''}%` } }
            ]
        },
        order: findOrder(sortOrder, sortBy),
        limit: Number(limit),
        offset: Number(offset),
        attributes: findUserFirstAttributes(sortBy),
        subQuery: false,
        include: [{ 
            model: Holon,
            as: 'FollowedHolons',
            attributes: [],
            through: { where: { state: 'active' }, attributes: [] }
        }],
    })
    .then(users => {
        User.findAll({ 
            where: { id: users.map(user => user.id) },
            order: findOrder(sortOrder, sortBy),
            attributes: userAttributes,
        }).then(data => { res.json(data) })
    })
    .catch(err => console.log(err))
})

router.get('/space-events', (req, res) => {
    const { spaceHandle, year, month } = req.query

    const startTime = new Date(`${year}-${month < 10 ? '0' : ''}${month}-01`)
    const endTime = new Date(`${year}-${+month + 1 < 10 ? '0' : ''}${+month + 1}-01`)

    Post.findAll({
        subQuery: false,
        where: { 
            '$DirectSpaces.handle$': spaceHandle,
            '$Event.startTime$': { [Op.between]: [startTime, endTime] },
            state: 'visible',
            type: ['event', 'glass-bead-game']
        },
        attributes: ['id', 'type'],
        include: [
            { 
                model: Holon,
                as: 'DirectSpaces',
                where: { state: 'active' },
            },
            { 
                model: Event,
                attributes: ['id', 'title', 'startTime']
            },
            {
                model: GlassBeadGame,
                attributes: ['topic', 'topicGroup', 'topicImage'],
            }
        ]
    })
    .then(data => res.json(data))
    .catch(err => console.log(err))
})

router.get('/holon-requests', (req, res) => {
    const { holonId } = req.query
    SpaceNotification
        .findAll({
            where: { type: 'parent-space-request', ownerId: holonId },
            order: [['createdAt', 'DESC']],
            include: [
                {
                    model: User,
                    as: 'triggerUser',
                    attributes: ['id', 'handle', 'name', 'flagImagePath'],
                },
                {
                    model: Holon,
                    as: 'triggerSpace',
                    attributes: ['id', 'handle', 'name', 'flagImagePath'],
                },
                // {
                //     model: Holon,
                //     as: 'secondarySpace',
                //     attributes: ['id', 'handle', 'name', 'flagImagePath'],
                // }
            ]
        })
        .then(notifications => {
            res.send(notifications)
        })
})

router.get('/space-map-data', async (req, res) => {
    const { spaceId, offset, sortBy, sortOrder, timeRange, depth, searchQuery } = req.query

    // todo:
    // apply all filters only on first generation? at least not 'sort by' or 'sort order'
    // apply depth 'all contained' spaces only on first generation?
    // apply search only on first generation?
    // apply time range only on first generation?

    async function findNextGeneration(generation, parent, limit, offsetAmount) {
        const genOffset = Number(offsetAmount)
        const childAttributes = [
            ...spaceAttributes,
            findTotalSpaceResults(depth, searchQuery, timeRange)
        ]
        parent.children = []
        if (!parent.isExpander && parent.totalResults > 0) {
            const nextGeneration = await Holon.findAll({
                where: findSpaceWhere(parent.id, depth, timeRange, searchQuery),
                attributes: childAttributes,
                limit,
                offset: genOffset > 0 ? genOffset : null,
                order: findOrder(sortOrder, sortBy),
                include: findSpaceInclude(depth),
                subQuery: false
            })
            nextGeneration.forEach(rawChild => {
                const child = rawChild.toJSON()
                child.uuid = uuidv4()
                parent.children.push(child)
            })
        }
        // if hidden spaces, replace last space with expander
        if (parent.children.length) {
            if (generation === 1) {
                if (parent.totalResults > genOffset + parent.children.length) {
                    parent.children.splice(-1, 1)
                    const remainingChildren = parent.totalResults - parent.children.length - genOffset
                    parent.children.push({ isExpander: true, id: uuidv4(), uuid: uuidv4(), name: `${remainingChildren} more spaces` })
                }
            } else {
                if (parent.totalResults > limit) {
                    parent.children.splice(-1, 1)
                    const remainingChildren = parent.totalResults - parent.children.length
                    parent.children.push({ isExpander: true, id: uuidv4(), uuid: uuidv4(), name: `${remainingChildren} more spaces` })
                }
            }
        }
    }

    const rootAttributes = [
        ...spaceAttributes,
        findTotalSpaceResults(depth, searchQuery, timeRange)
    ]
    const findRoot = await Holon.findOne({ 
        where: { id: spaceId },
        attributes: rootAttributes,
        include: [{
            model: Holon,
            as: 'DirectParentHolons',
            attributes: spaceAttributes,
            through: { attributes: [], where: { state: 'open' } },
        }]
    })
    const root = findRoot.toJSON()
    root.uuid = uuidv4()
    const findFirstGeneration = await findNextGeneration(1, root, firstGenLimit, offset)
    const findSecondGeneration = await asyncForEach(root.children, async(child) => {
        await findNextGeneration(2, child, secondGenLimit, 0)
    })
    const findThirdGeneration = await asyncForEach(root.children, async(child) => {
        await asyncForEach(child.children, async(child2) => {
            await findNextGeneration(3, child2, thirdGenLimit, 0)
        })
    })
    const findFourthGeneration = await asyncForEach(root.children, async(child) => {
        await asyncForEach(child.children, async(child2) => {
            await asyncForEach(child2.children, async(child3) => {
                await findNextGeneration(4, child3, fourthGenLimit, 0)
            })
        })
    })

    Promise
        .all([findFirstGeneration, findSecondGeneration, findThirdGeneration, findFourthGeneration])
        .then(() => {
            if (offset > 0) res.send(root.children)
            else res.send(root)
        })
})

router.get('/suggested-space-handles', (req, res) => {
    const { searchQuery } = req.query
    Holon.findAll({
        where: { state: 'active', handle: { [Op.like]: `%${searchQuery}%` } },
        attributes: ['handle']
    })
    .then(handles => { res.json(handles) })
    .catch(err => console.log(err))
})

router.get('/validate-space-handle', (req, res) => {
    const { searchQuery } = req.query
    Holon.findAll({
        where: { handle: searchQuery, state: 'active', },
        attributes: ['handle']
    })
    .then(holons => {
        if (holons.length > 0) { res.send('success') }
        else { res.send('fail') }
    })
    .catch(err => console.log(err))
})

router.get('/parent-space-blacklist', async (req, res) => {
    const { spaceId } = req.query

    Holon.findAll({
        attributes: ['id'],
        where: { '$HolonHandles.id$': spaceId, state: 'active', },
        include: {
            model: Holon,
            as: 'HolonHandles',
            attributes: [],
            through: { attributes: [], where: { state: 'open' } },
        }
    })
    .then(spaces => {
        const blacklist = spaces.map(s => s.id)
        // prevent users from adding the root space
        blacklist.push(1)
        res.send(blacklist)
    })
    .catch(err => console.log(err))
})

// POST
router.post('/create-space', authenticateToken, (req, res) => {
    const accountId = req.user.id
    const {
        accountName,
        accountHandle,
        parentId,
        authorizedToAttachParent,
        handle,
        name,
        description
    } = req.body

    Holon.findOne({ where: { handle, state: 'active' }})
        .then(space => {
            if (space) res.send('handle-taken')
            else {
                Holon.create({
                    creatorId: accountId,
                    handle,
                    name,
                    description,
                    state: 'active'
                }).then(async newSpace => {
                    // inherit unique id
                    HolonHandle.create({
                        // posts to spaceA appear within spaceB
                        holonAId: newSpace.id,
                        holonBId: newSpace.id,
                        state: 'open',
                    })
                    // create mod relationship
                    HolonUser.create({
                        relationship: 'moderator',
                        state: 'active',
                        holonId: newSpace.id,
                        userId: accountId
                    })
                    if (authorizedToAttachParent) {
                        // create vertical relationship
                        const createVerticalRelationship = await VerticalHolonRelationship.create({
                            state: 'open',
                            holonAId: parentId, // parent
                            holonBId: newSpace.id, // child
                        })
                        const addParentSpaceIdsToNewSpace = await Holon.findOne({
                            // find parent spaces's inherited ids
                            where: { id: parentId },
                            attributes: [],
                            include: {
                                model: Holon,
                                as: 'HolonHandles',
                                attributes: ['id'],
                                through: { attributes: [], where: { state: 'open' } },
                            }
                        }).then(parentSpace => {
                            // add inherited ids to new space
                            parentSpace.HolonHandles.forEach(space => {
                                HolonHandle.create({
                                    // posts to spaceA appear within spaceB
                                    holonAId: newSpace.id,
                                    holonBId: space.id,
                                    state: 'open',
                                })
                            })
                        })
                        Promise
                            .all([createVerticalRelationship, addParentSpaceIdsToNewSpace])
                            .then(res.send('success'))
                            .catch(error => console.log(error))
                    } else {
                        // attach to root
                        const attachToRoot = await VerticalHolonRelationship.create({
                            state: 'open',
                            holonAId: 1, // parent
                            holonBId: newSpace.id, // child
                        })
                        // inherit root id
                        const inheritRootId = await HolonHandle.create({
                            // posts to spaceA appear within spaceB
                            holonAId: newSpace.id,
                            holonBId: 1,
                            state: 'open',
                        })
                        // create space notification
                        const createSpaceNotification = await SpaceNotification.create({
                            ownerId: parentId,
                            type: 'parent-space-request',
                            state: 'pending',
                            holonAId: newSpace.id,
                            userId: accountId,
                            seen: false,
                        })
                        // get parent space data, inlcude mods
                        const parentSpace = await Holon.findOne({
                            where: { id: parentId },
                            attributes: ['id', 'handle', 'name'],
                            include: {
                                model: User,
                                as: 'Moderators',
                                attributes: ['id', 'handle', 'name', 'email'],
                                through: { where: { relationship: 'moderator', state: 'active' }, attributes: [] }
                            },
                        })
                        // send account notification and email to each of the mods
                        const notifyMods = await parentSpace.Moderators.forEach(moderator => {
                            Notification.create({
                                ownerId: moderator.id,
                                type: 'parent-space-request',
                                state: 'pending',
                                holonAId: newSpace.id,
                                holonBId: parentSpace.id,
                                userId: accountId,
                                seen: false,
                            }).then(() => {
                                sgMail.send({
                                    to: moderator.email,
                                    from: {
                                        email: 'admin@weco.io',
                                        name: 'we { collective }'
                                    },
                                    subject: 'New notification',
                                    text: `
                                        Hi ${moderator.name}, ${accountName} wants to make ${name} a child space of ${parentSpace.name} on weco.
                                    `,
                                    html: `
                                        <p>
                                            Hi ${moderator.name},
                                            <br/>
                                            <a href='${config.appURL}/u/${accountHandle}'>${accountName}</a>
                                            wants to make
                                            <a href='${config.appURL}/s/${handle}'>${name}</a>
                                            a child space of
                                            <a href='${config.appURL}/s/${parentSpace.handle}'>${parentSpace.name}</a>
                                            on weco.
                                            <br/>
                                            Log in and navigate
                                            <a href='${config.appURL}/u/${moderator.handle}/notifications'>here</a>
                                            or
                                            <a href='${config.appURL}/s/${parentSpace.handle}/settings'>here</a>
                                            to accept or reject the request.
                                        </p>
                                    `,
                                })
                            })
                        })
                        Promise
                            .all([attachToRoot, inheritRootId, createSpaceNotification, notifyMods])
                            .then(res.send('pending-acceptance'))
                            .catch(error => console.log(error))
                    }
                })

                
            }
        })

})

async function isAuthorizedModerator(accountId, spaceId) {
    // checks the logged in account is the mod of the space (is this actually required? is there a way for hackers to change the request payload?)
    // todo: try to get this info directly from the db, rather than having to calculate it server side
    return await User.findOne({
        where: { id: accountId },
        include: [{
            model: Holon,
            as: 'ModeratedHolons',
            attributes: ['id'],
            through: { where: { relationship: 'moderator', state: 'active' }, attributes: [] }
        }]
    }).then(user => {
        return user.ModeratedHolons.find(space => space.id === spaceId) ? true : false
    })
}

router.post('/update-space-handle', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId, payload } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        Holon.findOne({ where: { handle: payload } })
            .then(handleTaken => {
                if (handleTaken) res.send('handle-taken')
                else {
                    Holon.update({ handle: payload }, { where : { id: spaceId } })
                        .then(res.send('success'))
                        .catch(err => console.log(err))
                }
            })
    }
})

router.post('/update-space-name', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId, payload } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        Holon.update({ name: payload }, { where : { id: spaceId } })
            .then(res.send('success'))
            .catch(err => console.log(err))
    }
})

router.post('/update-space-description', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId, payload } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        Holon.update({ description: payload }, { where : { id: spaceId } })
            .then(res.send('success'))
            .catch(err => console.log(err))
    }
})

router.post('/invite-space-moderator', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId, spaceHandle, spaceName, accountName, accountHandle, userHandle } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        // find user, include moderated spaces
        User.findOne({
            where: { handle: userHandle },
            attributes: ['id', 'name', 'email'],
        }).then(user => {
            // create mod-invite notification
            Notification.create({
                ownerId: user.id,
                type: 'mod-invite',
                state: 'pending',
                seen: false,
                holonAId: spaceId,
                userId: accountId
            }).then(() => {
                // send mod-invite email
                sgMail.send({
                    to: user.email,
                    from: {
                        email: 'admin@weco.io',
                        name: 'we { collective }'
                    },
                    subject: 'New notification',
                    text: `
                        Hi ${user.name}, ${accountName} just invited you to moderate ${spaceName}: ${config.appURL}/s/${spaceHandle} on weco.
                        Log in and go to your notifications to accept the request.
                    `,
                    html: `
                        <p>
                            Hi ${user.name},
                            <br/>
                            <a href='${config.appURL}/u/${accountHandle}'>${accountName}</a>
                            just invited you to moderate
                            <a href='${config.appURL}/s/${spaceHandle}'>${spaceName}</a>
                            on weco.
                            <br/>
                            Log in and go to your notifications to accept the request.
                        </p>
                    `,
                }).then(() => res.send('success'))
                .catch((error) => console.log(`Failed to send email. Error: ${error}`))
            }).catch((error) => console.log(`Failed to create Notification. Error: ${error}`))
        }).catch((error) => console.log(`Failed to find user. Error: ${error}`))
    }
})

router.post('/remove-space-moderator', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId, spaceHandle, spaceName, accountName, accountHandle, userHandle } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        // find user, include moderated spaces
        User.findOne({
            where: { handle: userHandle },
            attributes: ['id', 'name', 'email'],
        }).then(user => {
            HolonUser.update({ state: 'removed' }, {
                where: { relationship: 'moderator', userId: user.id, holonId: spaceId }
            }).then(() => {
                // create mod-removed notification
                Notification.create({
                    ownerId: user.id,
                    type: 'mod-removed',
                    state: null,
                    seen: false,
                    holonAId: spaceId,
                    userId: accountId
                }).then(() => {
                    // send mod-removed email
                    sgMail.send({
                        to: user.email,
                        from: {
                            email: 'admin@weco.io',
                            name: 'we { collective }'
                        },
                        subject: 'New notification',
                        text: `
                            Hi ${user.name}, ${accountName} just removed you from moderating ${spaceName}: ${config.appURL}/s/${spaceHandle} on weco.
                        `,
                        html: `
                            <p>
                                Hi ${user.name},
                                <br/>
                                <a href='${config.appURL}/u/${accountHandle}'>${accountName}</a>
                                just removed you from moderating
                                <a href='${config.appURL}/s/${spaceHandle}'>${spaceName}</a>
                                on weco.
                                <br/>
                            </p>
                        `,
                    }).then(() => res.send('success'))
                    .catch((error) => console.log(`Failed to send email. Error: ${error}`))
                }).catch((error) => console.log(`Failed to create notification. Error: ${error}`))
            }).catch((error) => console.log(`Failed to update mod relationship. Error: ${error}`))
        }).catch((error) => console.log(`Failed to find user. Error: ${error}`))
    }
})

// todo: add authenticateToken to all endpoints below
router.post('/toggle-space-notification-seen', (req, res) => {
    let { notificationId, seen } = req.body
    SpaceNotification
        .update({ seen }, { where: { id: notificationId } })
        .then(res.send('success'))
})

router.post('/mark-all-space-notifications-seen', (req, res) => {
    let { holonId } = req.body
    SpaceNotification
        .update({ seen: true }, { where: { ownerId: holonId } })
        .then(res.send('success'))
})

router.post('/toggle-join-space', authenticateToken, (req, res) => {
    const accountId = req.user.id
    const { spaceId, isFollowing } = req.body
    if (isFollowing) {
        HolonUser
            .update({ state: 'removed' }, { where: { userId: accountId, holonId: spaceId, relationship: 'follower' }})
            .then(res.status(200).json({ message: 'Success' }))
            .catch(err => console.log(err))
    } else {
        HolonUser
            .create({ userId: accountId, holonId: spaceId, relationship: 'follower', state: 'active' })
            .then(res.status(200).json({ message: 'Success' }))
            .catch(err => console.log(err))
    }
})

router.post('/join-spaces', authenticateToken, (req, res) => {
    const accountId = req.user.id
    const spaceIds = req.body
    Promise
        .all(spaceIds.map((spaceId =>
            HolonUser.create({ userId: accountId, holonId: spaceId, relationship: 'follower', state: 'active' })
        )))
        .then(res.status(200).json({ message: 'Success' }))
        .catch(err => console.log(err))
})

router.post('/viable-parent-spaces', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId, query, blacklist } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        Holon.findAll({
            limit: 20,
            where: {
                state: 'active',
                [Op.not]: [{ id: blacklist }],
                [Op.or]: [
                    { handle: { [Op.like]: `%${query}%` } },
                    { name: { [Op.like]: `%${query}%` } },
                ],
            },
            attributes: ['id', 'handle', 'name', 'flagImagePath'],
            include: {
                model: User,
                as: 'Moderators',
                attributes: ['id'],
                through: { where: { relationship: 'moderator', state: 'active' }, attributes: [] }
            }
        })
        .then(spaces => res.send(spaces))
        .catch(err => console.log(err))
    }
})

router.post('/send-parent-space-request', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { accountHandle, accountName, spaceId, spaceName, spaceHandle, parentSpaceId } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        // get parent space data and moderators
        const parentSpace = await Holon.findOne({
            where: { id: parentSpaceId },
            attributes: ['id', 'handle', 'name'],
            include: {
                model: User,
                as: 'Moderators',
                attributes: ['id', 'handle', 'name', 'email'],
                through: { where: { relationship: 'moderator', state: 'active' }, attributes: [] }
            },
        })
        // send space notification
        const createSpaceNotification = await SpaceNotification.create({
            ownerId: parentSpace.id,
            type: 'parent-space-request',
            state: 'pending',
            holonAId: spaceId,
            userId: accountId,
            seen: false,
        })
        // send account notification and email to each of the mods
        const createAccountNotificationsAndEmails = await parentSpace.Moderators.forEach(moderator => {
            Notification.create({
                ownerId: moderator.id,
                type: 'parent-space-request',
                state: 'pending',
                holonAId: spaceId,
                holonBId: parentSpace.id,
                userId: accountId,
                seen: false,
            }).then(() => {
                sgMail.send({
                    to: moderator.email,
                    from: {
                        email: 'admin@weco.io',
                        name: 'we { collective }'
                    },
                    subject: 'New notification',
                    text: `
                        Hi ${moderator.name}, ${accountName} wants to make ${spaceName} a child space of ${parentSpace.name} on weco.
                    `,
                    html: `
                        <p>
                            Hi ${moderator.name},
                            <br/>
                            <a href='${config.appURL}/u/${accountHandle}'>${accountName}</a>
                            wants to make
                            <a href='${config.appURL}/s/${spaceHandle}'>${spaceName}</a>
                            a child space of
                            <a href='${config.appURL}/s/${parentSpace.handle}'>${parentSpace.name}</a>
                            on weco.
                            <br/>
                            Log in and navigate
                            <a href='${config.appURL}/u/${moderator.handle}/notifications'>here</a>
                            or
                            <a href='${config.appURL}/s/${parentSpace.handle}/settings'>here</a>
                            to accept or reject the request.
                        </p>
                    `,
                })
            })
        })
        Promise
            .all([createSpaceNotification, createAccountNotificationsAndEmails])
            .then(res.send('success'))
    }
})

// todo: create general purpose addParentSpace function/promise that resolves when complete to avoid code duplication

router.post('/add-parent-space', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId, parentSpaceId } = req.body
    const authorized = await isAuthorizedModerator(accountId, parentSpaceId)

    if (!authorized) res.send('unauthorized')
    else {
        // create vertical relationship
        const createVerticalRelationship = await VerticalHolonRelationship.create({
            state: 'open',
            holonAId: parentSpaceId, // parent
            holonBId: spaceId, // child
        })
        // remove old vertical relationship with root if present
        const removeVerticalRelationshipWithRoot = await Holon.findOne({
            where: { id: spaceId },
            attributes: [],
            include: {
                model: Holon,
                as: 'DirectParentHolons',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' } },
            }
        }).then(space => {
            if (space.DirectParentHolons.some(h => h.id === 1)) {
                VerticalHolonRelationship.update({ state: 'closed' }, { where: {
                    holonAId: 1, // parent
                    holonBId: spaceId // child
                }})
            }
        })
        // find parent spaces inherited ids
        const parentSpace = await Holon.findOne({
            where: { id: parentSpaceId },
            attributes: [],
            include: {
                model: Holon,
                as: 'HolonHandles',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' } },
            }
        })
        const parentSpaceInheritedIds = parentSpace.HolonHandles.map(h => h.id)
        // find effected spaces
        const effectedSpaces = await Holon.findAll({
            attributes: ['id'],
            where: { '$HolonHandles.id$': spaceId },
            include: {
                model: Holon,
                as: 'HolonHandles',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' } },
            }
        })
        // find effected spaces inherited ids
        const effectedSpacesWithInhertedIds = await Holon.findAll({
            where: { id: effectedSpaces.map(s => s.id) },
            include: [{
                model: Holon,
                as: 'HolonHandles',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' } }
            }]
        })
        // add parent spaces inherited ids to effected spaces inherited ids (if not already present)
        const inheritIds = await effectedSpacesWithInhertedIds.forEach(effectedSpace => {
            parentSpaceInheritedIds.forEach(id => {
                const match = effectedSpace.HolonHandles.some(h => h.id === id)
                if (!match) {
                    // posts to A appear within B
                    HolonHandle.create({
                        state: 'open',
                        holonAId: effectedSpace.id,
                        holonBId: id,
                    })
                }
            })
        })
        Promise
            .all([createVerticalRelationship, removeVerticalRelationshipWithRoot, inheritIds])
            .then(res.send('success'))
            .catch(error => console.log(error))
    }
})

router.post('/respond-to-parent-space-request', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const {
        // notificationId,
        // notificationType,
        // accountHandle,
        // accountName,
        triggerUser,
        childSpace,
        parentSpace,
        response
    } = req.body
    const authorized = await isAuthorizedModerator(accountId, parentSpace.id)

    console.log(req.body)

    if (!authorized) res.send('unauthorized')
    else {
        if (response === 'accepted') {
            // attach child to parent
            // todo: check connection not yet made first
            // create vertical relationship
            const createVerticalRelationship = await VerticalHolonRelationship.create({
                state: 'open',
                holonAId: parentSpace.id, // parent
                holonBId: childSpace.id, // child
            })
            // remove old vertical relationship with root if present
            const removeVerticalRelationshipWithRoot = await Holon.findOne({
                where: { id: childSpace.id },
                attributes: [],
                include: {
                    model: Holon,
                    as: 'DirectParentHolons',
                    attributes: ['id'],
                    through: { attributes: [], where: { state: 'open' } },
                }
            }).then(space => {
                if (space.DirectParentHolons.some(h => h.id === 1)) {
                    VerticalHolonRelationship.update({ state: 'closed' }, { where: {
                        holonAId: 1, // parent
                        holonBId: childSpace.id // child
                    }})
                }
            })
            // find parent spaces inherited ids
            const parentSpace2 = await Holon.findOne({
                where: { id: parentSpace.id },
                attributes: [],
                include: {
                    model: Holon,
                    as: 'HolonHandles',
                    attributes: ['id'],
                    through: { attributes: [], where: { state: 'open' } },
                }
            })
            const parentSpaceInheritedIds = parentSpace2.HolonHandles.map(h => h.id)
            // find effected spaces
            const effectedSpaces = await Holon.findAll({
                attributes: ['id'],
                where: { '$HolonHandles.id$': childSpace.id },
                include: {
                    model: Holon,
                    as: 'HolonHandles',
                    attributes: ['id'],
                    through: { attributes: [], where: { state: 'open' } },
                }
            })
            // find effected spaces inherited ids
            const effectedSpacesWithInhertedIds = await Holon.findAll({
                where: { id: effectedSpaces.map(s => s.id) },
                include: [{
                    model: Holon,
                    as: 'HolonHandles',
                    attributes: ['id'],
                    through: { attributes: [] }
                }]
            })
            // add parent spaces inherited ids to effected spaces inherited ids (if not already present)
            const inheritIds = await effectedSpacesWithInhertedIds.forEach(effectedSpace => {
                parentSpaceInheritedIds.forEach(id => {
                    const match = effectedSpace.HolonHandles.some(h => h.id === id)
                    if (!match) {
                        // posts to A appear within B
                        HolonHandle.create({
                            state: 'open',
                            holonAId: effectedSpace.id,
                            holonBId: id,
                        })
                    }
                })
            })
            // update account notifications (for all mods who received the request)
            const updateAccountNotifications = await Notification.update({ state: response, seen: true }, {
                where: {
                    // ownerId: accountId,
                    type: 'parent-space-request',
                    state: 'pending',
                    holonAId: childSpace.id,
                    holonBId: parentSpace.id,
                }
            })
            // update space notification
            const updateSpaceNotification = await SpaceNotification.update({ state: response, seen: true }, {
                where: { 
                    ownerId: parentSpace.id,
                    type: 'parent-space-request',
                    state: 'pending',
                    holonAId: childSpace.id,
                }
            })
            // send new notification to trigger user
            const sendNotificationToTriggerUser = await Notification.create({
                ownerId: triggerUser.id,
                type: `parent-space-request-response`,
                state: response,
                holonAId: childSpace.id,
                holonBId: parentSpace.id,
                userId: accountId,
                seen: false,
            })
            Promise
                .all([
                    createVerticalRelationship,
                    removeVerticalRelationshipWithRoot,
                    inheritIds,
                    updateAccountNotifications,
                    updateSpaceNotification,
                    sendNotificationToTriggerUser
                ])
                .then(res.send('success'))
                .catch(error => console.log(error))
        } else if (response === 'rejected') {
            // update account notifications (for all mods who received the request)
            const updateAccountNotifications = await Notification.update({ state: response, seen: true }, {
                where: {
                    // ownerId: accountId,
                    type: 'parent-space-request',
                    state: 'pending',
                    holonAId: childSpace.id,
                    holonBId: parentSpace.id,
                }
            })
            // update space notification
            const updateSpaceNotification = await SpaceNotification.update({ state: response, seen: true }, {
                where: { 
                    ownerId: parentSpace.id,
                    type: 'parent-space-request',
                    state: 'pending',
                    holonAId: childSpace.id,
                }
            })
            // send new notification to trigger user
            const sendNotificationToTriggerUser = await Notification.create({
                ownerId: triggerUser.id,
                type: `parent-space-request-response`,
                state: response,
                holonAId: childSpace.id,
                holonBId: parentSpace.id,
                userId: accountId,
                seen: false,
            })
            Promise
                .all([updateAccountNotifications, updateSpaceNotification, sendNotificationToTriggerUser])
                .then(res.send('success'))
                .catch(error => console.log(error))

        } 
    }
})

async function removeIds(childId, parentId, idsToRemove) {
    // Recursive function used to remove the correct ids from a space then apply the same logic to each of its children recursively.
    // The ids to remove are worked out by comparing the initial idsToRemove array passed into the function with
    // the ids of the childs other parents. If any match they are excluded from the removal list so posts to the selected
    // space still apear in those other parent spaces.
    // todo: if possible, keep track of recursive function progress and 
    // only return a success message once the full operation is complete

    // get selected space data (include inherited ids, direct parents with their inherited ids, and direct children) 
    const selectedSpace = await Holon.findOne({
        where: { id: childId },
        include: [
            {
                // inherited ids
                model: Holon,
                as: 'HolonHandles',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' } },
            },
            {
                // direct parents with their inherited ids
                model: Holon,
                as: 'DirectParentHolons',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' } },
                include: {
                    model: Holon,
                    as: 'HolonHandles',
                    attributes: ['id'],
                    through: { attributes: [], where: { state: 'open' } },
                }
            },
            {
                // direct children
                model: Holon,
                as: 'DirectChildHolons',
                attributes: ['id'],
                through: { attributes: [], where: { state: 'open' } },
            }
        ]
    })
    // gather other parents ids (excluding parent from previous iteration)
    // include 1 (the root id) by default to prevent it being removed
    let otherParentsIds = [1]
    selectedSpace.DirectParentHolons.forEach(parent => {
        if (parent.id !== parentId) otherParentsIds.push(...parent.HolonHandles.map(s => s.id))
    })
    // remove duplicates
    otherParentsIds = [...new Set(otherParentsIds)]
    // filter out otherParentsIds from idsToRemove
    const filteredIdsToRemove = idsToRemove.filter(id => !otherParentsIds.includes(id))
    // if any remaining idsToRemove, remove those ids from the selected space then run the same function for each of its children
    if (filteredIdsToRemove.length) {
        filteredIdsToRemove.forEach(id => {
            HolonHandle.update({ state: 'closed' }, { where: { holonAId: childId, holonBId: id } })
        })
        selectedSpace.DirectChildHolons.forEach(child => {
            // the current child becomes the parent in the next iteration
            removeIds(child.id, childId, filteredIdsToRemove)
        })
    } else {
        // todo: emit event and track progress so success message can be send back to user on completion?
    }
}

async function removeParentSpace(childId, parentId, callBack) {
    // fetch the parent spaces's inherited ids and pass them into the recursive removeIds function
    const parentToRemove = await Holon.findOne({
        where: { id: parentId },
        attributes: [],
        include: [{
            // inherited ids
            model: Holon,
            as: 'HolonHandles',
            attributes: ['id'],
            through: { attributes: [], where: { state: 'open' } },
        }]
    })
    const idsToRemove = parentToRemove.HolonHandles.map(s => s.id)
    removeIds(childId, parentId, idsToRemove)
    // if the parent being removed is the only parent of the child, attach the child to the root space
    const connectToRootIfRequired = await Holon.findOne({
        where: { id: childId },
        include: {
            model: Holon,
            as: 'DirectParentHolons',
            attributes: ['id'],
            through: { attributes: [], where: { state: 'open' } },
        }
    }).then(childSpace => {
        if (childSpace.DirectParentHolons.length === 1) {
            VerticalHolonRelationship.create({
                state: 'open',
                holonAId: 1,
                holonBId: childId,
            })
        }
    })
    // remove the old vertical relationship with the parent
    const removeVerticalRelationship = await VerticalHolonRelationship
        .update({ state: 'closed' }, { where: { holonAId: parentId, holonBId: childId }})
    // todo: send notifications? (if fromChild, send notification to parent mods, else to child mods)
    Promise
        .all([connectToRootIfRequired, removeVerticalRelationship])
        .then(() => { if (callBack) callBack() })
}

router.post('/remove-parent-space', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { childSpaceId, parentSpaceId, fromChild } = req.body
    const authorized = await isAuthorizedModerator(accountId, fromChild ? childSpaceId : parentSpaceId)

    if (!authorized) res.send('unauthorized')
    else {
        const callBack = () => res.send('success')
        removeParentSpace(childSpaceId, parentSpaceId, callBack)
    }
})

router.post('/delete-space', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { spaceId } = req.body
    const authorized = await isAuthorizedModerator(accountId, spaceId)

    if (!authorized) res.send('unauthorized')
    else {
        // find selected space, include direct parents and direct children
        const selectedSpace = await Holon.findOne({
            where: { id: spaceId },
            include: [
                {
                    // direct parents
                    model: Holon,
                    as: 'DirectParentHolons',
                    attributes: ['id'],
                    through: { attributes: [], where: { state: 'open' } },
                },
                {
                    // direct children
                    model: Holon,
                    as: 'DirectChildHolons',
                    attributes: ['id'],
                    through: { attributes: [], where: { state: 'open' } },
                }
            ]
        })
        // for each child, run remove parent logic (remove inherited ids, detach vertical relationships etc.)
        selectedSpace.DirectChildHolons.forEach(child => {
            removeParentSpace(child.id, spaceId)
        })
        // for each parent, remove vertical relationship
        selectedSpace.DirectParentHolons.forEach(parent => {
            VerticalHolonRelationship.update({ state: 'closed' }, { where: {
                holonAId: parent.id, // parent
                holonBId: spaceId // child
            }})
        })
        // delete space
        Holon
            .update({ state: 'removed-by-mod' }, { where: { id: spaceId } })
            .then(res.send('success'))
    }
})

module.exports = router
