'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Product', 'sellerId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: {
        model: 'User',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await queryInterface.createTable('ChatChannel', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
      },
      productId: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: {
          model: 'Product',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      sellerId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'User',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      isArchived: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      archivedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.createTable('ChatChannelMember', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
      },
      channelId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'ChatChannel',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'User',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      role: {
        type: Sequelize.ENUM('OWNER', 'MODERATOR', 'MEMBER'),
        allowNull: false,
        defaultValue: 'MEMBER',
      },
      status: {
        type: Sequelize.ENUM('ACTIVE', 'BANNED'),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      mutedUntil: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      lastReadAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('ChatChannelMember', ['channelId', 'userId'], {
      unique: true,
      name: 'chat_channel_member_channel_user_uq',
    });
    await queryInterface.addIndex('ChatChannelMember', ['userId'], {
      name: 'chat_channel_member_user_idx',
    });

    await queryInterface.createTable('ChatMessage', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
      },
      channelId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'ChatChannel',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      authorId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'User',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      replyToId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'ChatMessage',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      body: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      editedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    // Cursor-pagination + scrollback query shape: WHERE channelId = ? [AND id < ?] ORDER BY id DESC
    await queryInterface.addIndex('ChatMessage', {
      fields: ['channelId', { attribute: 'id', order: 'DESC' }],
      name: 'chat_message_channel_id_idx',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('ChatMessage');
    await queryInterface.dropTable('ChatChannelMember');
    await queryInterface.dropTable('ChatChannel');
    await queryInterface.removeColumn('Product', 'sellerId');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_ChatChannelMember_role";',
    );
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_ChatChannelMember_status";',
    );
  },
};
